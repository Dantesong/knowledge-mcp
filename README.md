# knowledge-mcp

A local MCP server that gives Claude Code persistent memory through a git-managed knowledge base.

## What it does

Exposes 9 tools to Claude Code via stdio MCP:

| Tool | Description |
|------|-------------|
| `kb_search` | Grep search across all .md files |
| `kb_read` | Read a specific document |
| `kb_write` | Write/append to a document (auto git commit, optional drift-stamping) |
| `kb_log_decision` | Log a technical decision with timestamp |
| `kb_index` | Rebuild the full document index |
| `kb_init` | Scan all projects for CLAUDE.md, auto-import into KB |
| `kb_link_track` | Link a doc to a source repo + paths it tracks (drift baseline) |
| `kb_drift` | Diff one doc vs source code since last verify; optional `bump` to rebaseline |
| `kb_drift_all` | Drift dashboard 🟢/🟡/🔴 across all linked docs (optional repo filter) |

Every write operation automatically commits to git, giving you version history of all knowledge changes.

## Drift detection (added 2026-04-25)

Plain `kb_write` is content-blind: calling it once per session satisfies the Stop hook even if 9 other docs that referenced the same code paths drifted silently. Long-term that produces major info gaps in the KB.

Drift detection links each doc to the code it documents via YAML frontmatter:

```yaml
---
last-verified-commit: a60044b1010084ebdb0a054e661bb8e8cb85829c
last-verified-at: 2026-04-25T15:30:00.000Z
code-repo: /Users/dante/develop/auto-hotelier
code-tracks: ["packages/db/prisma/schema.prisma","packages/db/prisma/migrations/"]
---

# Doc title
... body ...
```

Workflow:

1. **One-time setup** per doc: `kb_link_track` declares the repo + paths the doc tracks (or pass `codeRepo`+`codeTracks` directly to `kb_write`)
2. **At session start / phase boundaries**: `kb_drift_all` shows which docs are 🟢 at HEAD / 🟡 small drift / 🔴 major drift
3. **Per-doc drill-in**: `kb_drift <path>` outputs the actual `git log <last-verified>..HEAD -- <code-tracks>` so you see exactly which commits the doc may not yet reflect
4. **After updating a doc**: `kb_write` auto-stamps `last-verified-commit` to current HEAD so the drift counter resets
5. **No-op rebaseline**: `kb_drift <path> bump=true` for cases where source changed but the doc's claims didn't need an update

The Stop hook (`hooks/kb-stop-guard.sh`) uses the linkage too: if you change code in repo X, the hook scans all docs with `code-repo: X` and `code-tracks` matching your changed files, and blocks the stop until those specific docs are touched (or `kb_drift bump=true` is run on each).

## Install

```bash
git clone https://github.com/Dantesong/knowledge-mcp.git
cd knowledge-mcp
npm install
npm run build
```

## Setup your knowledge base

```bash
mkdir -p ~/knowledge/{systems,ops,decisions}
cd ~/knowledge && git init
echo "# Knowledge Base" > ~/knowledge/_index.md
git add -A && git commit -m "init: knowledge base"
```

**Directory structure:**
```
~/knowledge/
├── _index.md          ← Auto-generated index (rebuilt by kb_index)
├── systems/           ← System architecture docs
├── ops/               ← Operations & deployment docs
└── decisions/         ← Technical decision log
```

## Register with Claude Code

```bash
# Global (all projects)
claude mcp add --scope user knowledge -- node /path/to/knowledge-mcp/dist/index.js

# Or with custom KB location
claude mcp add --scope user knowledge -- node /path/to/knowledge-mcp/dist/index.js -e KNOWLEDGE_DIR=/path/to/knowledge
```

## Enforcement hooks (recommended)

The MCP server provides the tools, but Claude won't reliably use them without enforcement. This repo includes two Claude Code hooks that make knowledge updates **mandatory**:

### What the hooks do

| Hook | Event | Behavior |
|------|-------|----------|
| `kb-session-start.sh` | `SessionStart` | Injects `_index.md` + protocol rules into Claude's context at session start. Claude sees the full catalog of knowledge docs before doing anything. |
| `kb-stop-guard.sh` | `Stop` | Checks if the working tree has uncommitted code changes AND no `kb_write`/`kb_log_decision` was called this session. If so, **blocks Claude from stopping** until knowledge is updated. |

### Install the hooks

**Step 1: Copy hook scripts**

```bash
mkdir -p ~/.claude/hooks
cp hooks/kb-session-start.sh ~/.claude/hooks/
cp hooks/kb-stop-guard.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/kb-session-start.sh ~/.claude/hooks/kb-stop-guard.sh
```

**Step 2: Register hooks in Claude Code settings**

Edit `~/.claude/settings.json` and add the `hooks` section (merge with existing content):

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

**Step 3: Add Knowledge Protocol to CLAUDE.md**

Append to `~/.claude/CLAUDE.md` (or your project-level CLAUDE.md):

```markdown
## Knowledge Protocol (MANDATORY — GLOBAL)

`~/knowledge/` is the **global source of truth** for all projects.

**Tools available** (via the `knowledge` MCP server, prefix `mcp__knowledge__`):
- `kb_search` — grep across all `*.md` in the knowledge base
- `kb_read` — read a specific file by relative path
- `kb_write` — write/overwrite a file (auto-commits)
- `kb_log_decision` — append a decision entry to `decisions/decisions.md`
- `kb_index` — rebuild `_index.md` from current files

**Rules:**
1. Before modifying code/schema/deployment, read the relevant knowledge docs first.
2. After completing meaningful changes, update knowledge via `kb_write`, then `kb_index`.
3. A Stop hook enforces this: code changes without a knowledge update will block session end.
4. Trivial changes (typos, formatting) are exempt — tell the user and ask for confirmation.
5. If knowledge contradicts code, stop and ask — don't silently fix either side.
```

**Step 4: Restart Claude Code**

Hooks are snapshot at session start. Close all Claude Code sessions and reopen for changes to take effect.

### How the Stop hook decides

```
stop_hook_active = true?            → allow (loop guard, prevents infinite block)
cwd in ~/knowledge/ or ~/.claude/?  → allow (excluded dirs)
cwd not in a git repo?              → allow (nothing to enforce)
git working tree clean?             → allow (no code changes to document)
~/knowledge/ repo is dirty?         → allow (knowledge already being updated)
session transcript has kb_write?    → allow (knowledge was updated via MCP)
none of the above                   → BLOCK (code changed, knowledge not updated)
```

Filtered noise (won't trigger block): `tsconfig.tsbuildinfo`, `HANDOFF.md`, `.next/`, `node_modules/`, `dist/`, `build/`, `.DS_Store`, `*.log`

### Customization

**Excluded directories** — edit `EXCLUDED_DIRS` in `~/.claude/hooks/kb-stop-guard.sh`:
```bash
EXCLUDED_DIRS=(
  "$HOME/knowledge"
  "$HOME/.claude"
  # Add more dirs to exclude from enforcement:
  # "$HOME/throwaway-experiments"
)
```

**Noise filter** — edit the `grep -v -E` pattern in `kb-stop-guard.sh` to add more build artifacts that shouldn't trigger the block.

**Debug log** — the Stop hook logs every invocation to `~/.claude/hooks/kb-stop-guard.log`.

### Dependencies

The Stop hook requires `jq` for JSON output. macOS 15+ includes it at `/usr/bin/jq`. On Linux:
```bash
# Ubuntu/Debian
sudo apt install jq
# or Homebrew
brew install jq
```

## Bootstrap from existing projects

After install, run `kb_init` to auto-import all your CLAUDE.md files:

```
> Initialize my knowledge base from all my projects
  → calls kb_init(scan_dirs="~,~/dev,~/projects")
```

This scans for CLAUDE.md files, extracts key info, and creates docs in `~/knowledge/systems/`. Safe to run multiple times — skips files that already exist.

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

## Multi-machine sync

The knowledge base is a standard git repo. Push to GitHub for multi-machine sync:

```bash
# Machine A (after Claude writes knowledge)
cd ~/knowledge && git push

# Machine B
cd ~/knowledge && git pull
```

The MCP server auto-commits on every write. You just need to push/pull.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KNOWLEDGE_DIR` | `~/knowledge` | Path to knowledge base directory |

## How it works

```
Claude Code ←→ stdio ←→ knowledge-mcp ←→ ~/knowledge/ (local files)
                                              ↓
                                          git auto-commit
                                              ↓
                                      GitHub (optional remote sync)
```

- **Transport**: stdio (local only, no network)
- **Git**: Every `kb_write` and `kb_log_decision` runs `git add -A && git commit`
- **Index**: Auto-rebuilt after every write
- **Security**: Path traversal protection — can't escape KB directory
- **Enforcement**: Optional hooks block Claude from ending sessions without updating knowledge

## License

MIT
