# knowledge-mcp

A local MCP server that gives Claude Code persistent memory through a git-managed knowledge base.

## What it does

Exposes 5 tools to Claude Code via stdio MCP:

| Tool | Description |
|------|-------------|
| `kb_search` | Grep search across all .md files |
| `kb_read` | Read a specific document |
| `kb_write` | Write/append to a document (auto git commit) |
| `kb_log_decision` | Log a technical decision with timestamp |
| `kb_index` | Show the full document index |

Every write operation automatically commits to git, giving you version history of all knowledge changes.

## Install

```bash
git clone https://github.com/Dantesong/knowledge-mcp.git
cd knowledge-mcp
npm install
npm run build
```

## Setup your knowledge base

```bash
mkdir -p ~/knowledge/{systems,ops,decisions,inbox,scripts}
cd ~/knowledge && git init
echo "# Knowledge Base" > ~/knowledge/_index.md
```

**Directory structure:**
```
~/knowledge/
├── _index.md          ← Auto-generated index
├── systems/           ← System architecture docs
├── ops/               ← Operations & deployment docs
├── decisions/         ← Technical decision log
├── inbox/             ← Unclassified docs (plans, drafts)
└── scripts/           ← Helper scripts (optional)
```

## Add to Claude Code

```bash
# Global (all projects)
claude mcp add --scope user knowledge -- node /path/to/knowledge-mcp/dist/index.js

# Or with custom KB location
claude mcp add --scope user knowledge -- node /path/to/knowledge-mcp/dist/index.js -e KNOWLEDGE_DIR=/path/to/knowledge
```

## Usage

Once configured, Claude Code can use the tools directly:

```
> Search my knowledge base for "webhook"
  → calls kb_search("webhook")

> Read the hotel automation doc
  → calls kb_read("systems/hotel-automation.md")

> Add a note about the new API endpoint
  → calls kb_write("systems/api.md", "## New Endpoint\n...", "append")

> Log why we chose PostgreSQL over MongoDB
  → calls kb_log_decision("PostgreSQL over MongoDB", "Need ACID transactions for...")
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KNOWLEDGE_DIR` | `~/knowledge` | Path to knowledge base directory |

## How it works

- **Transport**: stdio (local only, no network)
- **Git**: Every `kb_write` and `kb_log_decision` runs `git add -A && git commit`
- **Index**: Auto-rebuilt after every write
- **Security**: Path traversal protection — can't escape KB directory

## License

MIT
