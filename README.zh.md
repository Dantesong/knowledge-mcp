# knowledge-mcp

给 Claude Code 装上持久记忆 — 通过 Git 管理的本地知识库。

## 解决什么问题

Claude Code 每次新开 session 都会"失忆"。CLAUDE.md 能写规则，但写不了记忆。

这个 MCP server 让 AI 能直接读写一个本地知识库目录（`~/knowledge/`），每次写入自动 git commit，跨 session 持久化。

## 6 个工具

| 工具 | 用途 |
|------|------|
| `kb_search` | 全文搜索所有 .md 文件 |
| `kb_read` | 读取指定文档 |
| `kb_write` | 写入/追加文档（自动 git commit） |
| `kb_log_decision` | 记录技术决策（带时间戳） |
| `kb_index` | 重建知识库目录索引 |
| `kb_init` | 扫描所有项目的 CLAUDE.md，自动导入知识库 |

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
| `kb-session-start.sh` | `SessionStart` | session 启动时把 `_index.md` + 协议规则注入 Claude 的 context。Claude 一开始就看到所有知识文档的目录。 |
| `kb-stop-guard.sh` | `Stop` | session 结束前检查：工作目录有未提交的代码改动吗？本 session 调过 `kb_write` 吗？如果代码改了但知识库没更新，**阻止 Claude 结束 session**。 |

### 安装 hooks

**步骤 1：复制 hook 脚本**

```bash
mkdir -p ~/.claude/hooks
cp hooks/kb-session-start.sh ~/.claude/hooks/
cp hooks/kb-stop-guard.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/kb-session-start.sh ~/.claude/hooks/kb-stop-guard.sh
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
git 工作区干净?                        → 放行（没有代码改动）
~/knowledge/ repo 有未提交修改?        → 放行（知识库已在更新）
本 session 调过 kb_write?             → 放行（通过 MCP 更新了知识库）
以上都不满足                           → 阻止（代码改了，知识库没更新）
```

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
- **Git**: 每次 `kb_write` 和 `kb_log_decision` 自动 `git add -A && git commit`
- **索引**: 每次写入后自动重建 `_index.md`
- **安全**: 路径遍历保护 — 无法访问知识库目录之外的文件
- **强制执行**: 可选 hooks 阻止 Claude 在未更新知识库的情况下结束 session

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
