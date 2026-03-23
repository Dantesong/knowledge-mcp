# knowledge-mcp

给 Claude Code 装上持久记忆 — 通过 Git 管理的本地知识库。

## 解决什么问题

Claude Code 每次新开 session 都会"失忆"。CLAUDE.md 能写规则，但写不了记忆。

这个 MCP server 让 AI 能直接读写一个本地知识库目录（`~/knowledge/`），每次写入自动 git commit，跨 session 持久化。

## 5 个工具

| 工具 | 用途 |
|------|------|
| `kb_search` | 全文搜索所有 .md 文件 |
| `kb_read` | 读取指定文档 |
| `kb_write` | 写入/追加文档（自动 git commit） |
| `kb_log_decision` | 记录技术决策（带时间戳） |
| `kb_index` | 查看知识库目录索引 |
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
mkdir -p ~/knowledge/{systems,ops,decisions,inbox}
cd ~/knowledge && git init
echo "# Knowledge Base" > ~/knowledge/_index.md
```

**目录说明：**
```
~/knowledge/
├── _index.md          ← 自动生成的索引
├── systems/           ← 系统架构文档
├── ops/               ← 运维部署文档
├── decisions/         ← 技术决策日志
└── inbox/             ← 未归类文档（计划、草稿）
```

## 注册到 Claude Code

```bash
# 全局注册（所有项目可用）
claude mcp add --scope user knowledge -- node /你的路径/knowledge-mcp/dist/index.js

# 自定义知识库路径
claude mcp add --scope user knowledge -- node /你的路径/knowledge-mcp/dist/index.js -e KNOWLEDGE_DIR=/自定义路径/knowledge
```

## 一键导入现有项目

安装后，让 AI 跑一次 `kb_init`，自动扫描所有项目的 CLAUDE.md 并导入：

```
你: 初始化知识库，把所有项目的文档导入
AI: → 调用 kb_init(scan_dirs="~,~/dev,~/projects")

输出:
  Scanned: /Users/you, /Users/you/dev, /Users/you/projects
  Found 5 CLAUDE.md files:
    systems/my-app.md ← ~/dev/my-app/CLAUDE.md (imported)
    systems/api-server.md ← ~/dev/api-server/CLAUDE.md (imported)
    ops/global-rules.md ← ~/.claude/CLAUDE.md (imported)
    ...
```

安全重复执行 — 已存在的文件会跳过。

## 使用方式

注册后，新开一个 Claude Code session，AI 就能直接调用：

```
你: 搜一下知识库里关于 webhook 的内容
AI: → 调用 kb_search("webhook")

你: 读一下系统架构文档
AI: → 调用 kb_read("systems/my-system.md")

你: 把刚才的改动记录到知识库
AI: → 调用 kb_write("systems/my-system.md", "## 新增功能\n...", "append")

你: 记录一下为什么选了 PostgreSQL
AI: → 调用 kb_log_decision("选择 PostgreSQL", "需要 ACID 事务...")
```

## 工作原理

```
Claude Code ←→ stdio ←→ knowledge-mcp ←→ ~/knowledge/ (本地文件)
                                              ↓
                                          git auto-commit
                                              ↓
                                      GitHub (可选远程同步)
```

- **传输**: stdio（纯本地，不走网络）
- **Git**: 每次 `kb_write` 和 `kb_log_decision` 自动 `git add -A && git commit`
- **索引**: 每次写入后自动重建 `_index.md`
- **安全**: 路径遍历保护 — 无法访问知识库目录之外的文件

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KNOWLEDGE_DIR` | `~/knowledge` | 知识库目录路径 |

## 多端同步

知识库是标准 Git repo，推到 GitHub 后多台机器可以同步：

```bash
# 机器 A 写了新内容
cd ~/knowledge && git push

# 机器 B 拉取
cd ~/knowledge && git pull
```

## 配合 CLAUDE.md 使用

在 `~/.claude/CLAUDE.md` 全局规则中加入：

```markdown
## 知识库规则
- 完成系统架构变更后，调用 kb_write 更新对应文档
- 做出重要技术决策后，调用 kb_log_decision 记录
- 新 session 开始时，调用 kb_index 了解现有知识
```

这样 AI 不仅有工具，还有使用工具的规则。规则 + 工具 = 可靠的持久记忆。

## License

MIT
