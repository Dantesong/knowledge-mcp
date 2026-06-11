# knowledge-mcp

给 Claude Code 装上持久记忆 — 通过 Git 管理的本地知识库。

## 解决什么问题

Claude Code 每次新开 session 都会"失忆"。CLAUDE.md 能写规则，但写不了记忆。

这个 MCP server 让 AI 能直接读写一个本地知识库目录（`~/knowledge/`），每次写入自动 git commit，跨 session 持久化。

## 9 个工具

| 工具 | 用途 |
|------|------|
| `kb_search` | 全文搜索所有 .md 文件 — 默认按字面字符串匹配（`regex:true` 才按正则），结果超 50 行会提示真实总数 |
| `kb_read` | 读取文档。支持 `{section:"标题文本"}` 按节取、`{offset,limit}` 按行取；>40KB 的文件默认只返回标题大纲（`full:true` 强制整读） |
| `kb_write` | 写入/追加文档（自动 git commit）。**写入 ≠ 验证**：drift 基线只在传 `codeRepo` 或 replace 带 `verified:true` 时才会刷新 |
| `kb_log_decision` | 记录技术决策（带时间戳） |
| `kb_index` | 重建并返回 `_index.md` 索引（每次调用都真重建） |
| `kb_init` | 扫描所有项目的 CLAUDE.md，自动导入知识库 |
| `kb_link_track` | 把文档挂到源码 repo + 它追踪的路径上（drift 基线） |
| `kb_drift` | 对比单个文档与源码的漂移（`git log <上次验证>..HEAD`）；`bump=true` 重新盖章 |
| `kb_drift_all` | 全库 drift 仪表盘 🟢/🟡/🔴/⚠️（可按 repo 过滤） |

每次写入自动 git commit，且**只暂存工具自己写的文件**（绝不 `git add -A`）——并发 session 留在工作区的未提交改动不会被吞进无关 commit。文件超 4000 行 / 200KB 时返回里会带轮转提醒。

## Drift 检测（文档与代码的漂移追踪）

每个文档可通过 YAML frontmatter 挂到它描述的代码上（`code-repo` / `code-tracks` / `last-verified-commit`）。流程：

1. 每个文档一次性 `kb_link_track` 挂上 repo + 追踪路径
2. session 开始 / 阶段边界跑 `kb_drift_all` 看哪些文档落后了
3. `kb_drift <path>` 钻取具体是哪些 commit 还没反映进文档
4. 人工核对文档与 HEAD 一致后，用 `kb_write` replace + `verified:true`（或 `kb_drift bump=true`）重新盖章——**日常追加日志永远不会动基线**（v1.0 曾自动刷新，导致真实漂移被静默清零）
5. 基线 commit 因 rebase 不可达时显示 ⚠️ + git 错误，而不是假 🟢

## 安装

```bash
git clone https://github.com/Dantesong/knowledge-mcp.git
cd knowledge-mcp
npm install
npm run build
```

## 初始化知识库

```bash
mkdir -p ~/knowledge/{systems,ops,decisions}
cd ~/knowledge && git init
echo "# Knowledge Base" > ~/knowledge/_index.md
git add -A && git commit -m "init: knowledge base"
```

**目录说明：**
```
~/knowledge/
├── _index.md          ← 自动生成的索引（kb_index 重建）
├── systems/           ← 系统架构文档
├── ops/               ← 运维部署文档
└── decisions/         ← 技术决策日志
```

## 注册到 Claude Code

```bash
# 全局注册（所有项目可用）
claude mcp add --scope user knowledge -- node /你的路径/knowledge-mcp/dist/index.js

# 自定义知识库路径
claude mcp add --scope user knowledge -- node /你的路径/knowledge-mcp/dist/index.js -e KNOWLEDGE_DIR=/自定义路径/knowledge
```

## 强制执行 hooks（推荐）

MCP server 提供工具，但 Claude 不会每次都自觉使用。本 repo 包含两个 Claude Code hooks，让知识库更新成为**强制行为**：

### 两个 hook 的作用

| Hook | 事件 | 行为 |
|------|------|------|
| `kb-session-start.sh` | `SessionStart` | session 启动时把 `_index.md` 注入 Claude 的 context（协议规则放 CLAUDE.md，hook 里不重复注入——否则每个 session 为同一段文字付两次 token）。 |
| `kb-stop-guard.sh` | `Stop` | session 结束前检查：工作目录有未提交的代码改动（或最近一小时有 commit）吗？本 session 调过 `kb_write` 吗？如果代码改了但知识库没更新，**阻止 Claude 结束 session**。 |

### 安装 hooks

**步骤 1：symlink hook 脚本**（单一源——repo 里的文件就是线上 hook。用 `cp` 部署的下场：本 repo 自己的 hook 曾和部署副本分叉 47 天没人发现）

```bash
mkdir -p ~/.claude/hooks
chmod +x hooks/kb-session-start.sh hooks/kb-stop-guard.sh
ln -sf "$(pwd)/hooks/kb-session-start.sh" ~/.claude/hooks/kb-session-start.sh
ln -sf "$(pwd)/hooks/kb-stop-guard.sh" ~/.claude/hooks/kb-stop-guard.sh
```

**步骤 2：注册到 Claude Code 配置**

编辑 `~/.claude/settings.json`，加入 `hooks` 段（跟现有配置合并）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/hooks/kb-session-start.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/hooks/kb-stop-guard.sh"
          }
        ]
      }
    ]
  }
}
```

**步骤 3：在 CLAUDE.md 中加入知识库协议**

追加到 `~/.claude/CLAUDE.md`（全局规则）：

```markdown
## 知识库协议（强制 — 全局生效）

`~/knowledge/` 是所有项目的**唯一事实来源**。

**可用工具**（通过 `knowledge` MCP server，前缀 `mcp__knowledge__`）：
- `kb_search` — 在知识库中搜索关键词
- `kb_read` — 按路径读取某个文件
- `kb_write` — 写入/覆盖文件（自动 commit）
- `kb_log_decision` — 在 decisions/decisions.md 追加决策记录
- `kb_index` — 重建 _index.md 索引

**规则：**
1. 修改代码/schema/部署之前，先读取相关的知识文档。
2. 完成有意义的改动后，用 `kb_write` 更新知识文档，然后 `kb_index` 重建索引。
3. Stop hook 强制执行：代码改了但知识库没更新 = 不能结束 session。
4. 纯粹修改 typo、格式的例外 — 告诉用户并确认后可跳过。
5. 知识库与代码矛盾时，停下来问用户 — 不要擅自修改任何一方。
```

**步骤 4：重启 Claude Code**

Hooks 在 session 启动时加载。关闭所有 Claude Code session，重新打开即可生效。

### Stop hook 判定逻辑

```
stop_hook_active = true?              → 放行（循环保护，防止死循环）
cwd 在 ~/knowledge/ 或 ~/.claude/?   → 放行（排除目录）
cwd 不在 git repo 内?                 → 放行（没有代码可追踪）
工作区干净 且 最近一小时无 commit?      → 放行（没有代码改动）
本 session 调过 kb_write?             → 放行（通过 MCP 更新了知识库）
以上都不满足                           → 阻止（代码改了，知识库没更新）
```

> v1.2 删掉了旧的"~/knowledge/ 有未提交修改 → 放行"：它分不清是**本 session** 更新了知识库还是**并发 session** 留下的脏文件——只要有一个并行 session 在干活，其他所有 session 全部免检。现在 transcript 里的 kb_write 是唯一自动放行通道。

过滤的噪声文件（不会触发阻止）：`tsconfig.tsbuildinfo`, `HANDOFF.md`, `.next/`, `node_modules/`, `dist/`, `build/`, `.DS_Store`, `*.log`

### 自定义

**排除目录** — 编辑 `~/.claude/hooks/kb-stop-guard.sh` 中的 `EXCLUDED_DIRS`：
```bash
EXCLUDED_DIRS=(
  "$HOME/knowledge"
  "$HOME/.claude"
  # 添加更多不需要强制执行的目录：
  # "$HOME/throwaway-experiments"
)
```

**噪声过滤器** — 编辑 `kb-stop-guard.sh` 中的 `grep -v -E` 正则，添加更多不该触发阻止的 build 产物。

**调试日志** — Stop hook 每次执行都会写入 `~/.claude/hooks/kb-stop-guard.log`。

### 依赖

Stop hook 需要 `jq` 来输出 JSON。macOS 15+ 自带 `/usr/bin/jq`。Linux 上：
```bash
sudo apt install jq   # Ubuntu/Debian
brew install jq        # Homebrew
```

## 一键导入现有项目

安装后，让 AI 跑一次 `kb_init`，自动扫描所有项目的 CLAUDE.md 并导入：

```
你: 初始化知识库，把所有项目的文档导入
AI: → 调用 kb_init(scan_dirs="~,~/dev,~/projects")
```

安全重复执行 — 已存在的文件会跳过。

## 使用方式

注册后，新开一个 Claude Code session，AI 就能直接调用：

```
你: 搜一下知识库里关于 webhook 的内容
AI: → kb_search("webhook")

你: 读一下系统架构文档
AI: → kb_read("systems/my-system.md")

你: 把刚才的改动记录到知识库
AI: → kb_write("systems/my-system.md", "## 新增功能\n...", "append")

你: 记录一下为什么选了 PostgreSQL
AI: → kb_log_decision("选择 PostgreSQL", "需要 ACID 事务...")
```

## 工作原理

```
Claude Code ←→ stdio ←→ knowledge-mcp ←→ ~/knowledge/（本地文件）
                                              ↓
                                          git auto-commit
                                              ↓
                                      GitHub（可选远程同步）
```

- **传输**: stdio（纯本地，不走网络）
- **Git**: 每次 `kb_write` 和 `kb_log_decision` 只暂存并提交**自己写的文件**（不碰其他 session 的工作区改动）；git 报错会显示 `git error: …` 而不是静默吞掉
- **索引**: 每次写入后自动重建 `_index.md`；标题取第一个 markdown heading（frontmatter / SUPERSEDED banner 不再污染标题），废弃文档带 [SUPERSEDED] 标记，inbox/ 也列入
- **安全**: 路径遍历保护（含 `~/knowledge-evil` 这类同前缀兄弟目录）；所有 git/grep 调用走参数数组，用户文本不进 shell
- **强制执行**: 可选 hooks 阻止 Claude 在未更新知识库的情况下结束 session

## 更新日志

### v1.1.1 (2026-06-11)

- **session-start hook v1.3** — 按 `source` 区分注入：`resume` 直接跳过（旧注入随 transcript 已在上下文里，重注是纯重复 ~1.2k token）；每次调用把 `source` + 字节数记入 `~/.claude/hooks/kb-session-start.log`，先测量事件分布再决定是否进一步瘦身。
- **工具 description 精简** — 9 个工具 + 冗长参数说明从 ~7.3KB schema 压到 5.5KB（在全量加载 MCP schema 的环境里每 session 省 ~450 token）。

### v1.1.0 (2026-06-11)

- **精确暂存** — 废除 `git add -A`，只提交工具自己写的文件（并发 session 安全）
- **写入 ≠ 验证** — append 永不刷新 `last-verified-commit`；replace 需显式 `verified:true` 或带 `codeRepo`；replace 时新内容没带 frontmatter 自动继承旧的
- **诚实 drift** — 基线 commit 不可达时报 ⚠️ + git 错误，不再假 🟢
- **大文件分段** — `kb_read` 新增 `section` / `offset`+`limit` / `full`；>40KB 默认返回标题大纲
- **轮转提醒** — 写入后文件超 4000 行 / 200KB 在返回里警告
- **`kb_index` 真重建**（此前只在索引文件不存在时才重建）
- **`kb_search`** 默认字面匹配、`regex:true` 选启、截断提示真实总数
- **注入加固** — git/grep 全部参数数组化；`kbPath` 要求 KB 根目录后必须有路径分隔符
- **Hooks v1.2** — stop-guard 删 dirty-KB 免检；session-start 只注入索引；symlink 部署
- E2E 测试：`npm run build && node test/e2e.test.mjs`（33 项检查）

## 多端同步

知识库是标准 Git repo，推到 GitHub 后多台机器可以同步：

```bash
# 机器 A（Claude 写了新内容后）
cd ~/knowledge && git push

# 机器 B
cd ~/knowledge && git pull
```

MCP server 写入时自动 commit，你只需要 push/pull。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KNOWLEDGE_DIR` | `~/knowledge` | 知识库目录路径 |

## License

MIT
