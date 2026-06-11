# knowledge-mcp

A local MCP server that gives Claude Code persistent memory through a git-managed knowledge base.

## What it does

Exposes 9 tools to Claude Code via stdio MCP:

| Tool | Description |
|------|-------------|
| `kb_search` | Search across all .md files — fixed-string by default (`regex:true` opt-in), truncation note with real match count |
| `kb_read` | Read a document. `{section:"heading text"}` / `{offset,limit}` slices; files >40KB return a heading outline by default (`full:true` to force) |
| `kb_write` | Write/append to a document (auto git commit). Writing ≠ verifying: the drift baseline only moves with `codeRepo` or `verified:true` on a replace |
| `kb_log_decision` | Log a technical decision with timestamp |
| `kb_index` | Rebuild `_index.md` from current files (always regenerates) and return it |
| `kb_init` | Scan all projects for CLAUDE.md, auto-import into KB |
| `kb_link_track` | Link a doc to a source repo + paths it tracks (drift baseline) |
| `kb_drift` | Diff one doc vs source code since last verify; optional `bump` to rebaseline |
| `kb_drift_all` | Drift dashboard 🟢/🟡/🔴/⚠️ across all linked docs (optional repo filter) |

Every write operation automatically commits to git — staging **only the files the tool itself wrote** (never `git add -A`), so concurrent sessions' uncommitted work in the KB working tree is never swallowed into unrelated commits. Oversized files (>4000 lines / 200KB) trigger a rotation warning in the tool response.

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
2. **At session start / phase boundaries**: `kb_drift_all` shows which docs are 🟢 at HEAD / 🟡 small drift / 🔴 major drift / ⚠️ baseline unreachable
3. **Per-doc drill-in**: `kb_drift <path>` outputs the actual `git log <last-verified>..HEAD -- <code-tracks>` so you see exactly which commits the doc may not yet reflect
4. **After verifying a doc against HEAD**: `kb_write` with `mode:"replace", verified:true` (or with `codeRepo`) re-stamps `last-verified-commit`. **Writing alone never moves the baseline** — v1.0 auto-stamped on every write, which let routine log appends silently erase real drift (false-fresh)
5. **No-op rebaseline**: `kb_drift <path> bump=true` for cases where source changed but the doc's claims didn't need an update

If the baseline commit becomes unreachable (rebase/amend), `kb_drift` reports ⚠️ with the git error instead of a false 🟢 — an unreadable history is not "zero drift".

> A fine-grained Stop-hook variant that scans `code-tracks` against your changed files and blocks per-doc lives in git history (`f01e3d6`, "option C"). It is deliberately not deployed — re-evaluate once baselines have been honest for a while.

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
| `kb-session-start.sh` | `SessionStart` | Injects `_index.md` into Claude's context at session start (protocol rules belong in `CLAUDE.md` — injecting them here too would pay for the same text twice per session). |
| `kb-stop-guard.sh` | `Stop` | Checks if the working tree has uncommitted code changes (or commits in the last hour) AND no `kb_write`/`kb_log_decision` was called this session. If so, **blocks Claude from stopping** until knowledge is updated. |

### Install the hooks

**Step 1: Symlink hook scripts** (single source — the repo copy IS the live hook; `cp` instead of `ln -s` is how this repo's own hooks drifted from the deployed copies for 47 days unnoticed)

```bash
mkdir -p ~/.claude/hooks
chmod +x hooks/kb-session-start.sh hooks/kb-stop-guard.sh
ln -sf "$(pwd)/hooks/kb-session-start.sh" ~/.claude/hooks/kb-session-start.sh
ln -sf "$(pwd)/hooks/kb-stop-guard.sh" ~/.claude/hooks/kb-stop-guard.sh
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
working tree clean AND no commits
  in the last hour?                 → allow (no code changes to document)
session transcript has kb_write?    → allow (knowledge was updated via MCP)
none of the above                   → BLOCK (code changed, knowledge not updated)
```

> v1.2 removed the old "`~/knowledge/` repo is dirty → allow" pass: it couldn't tell *this* session's KB update from a concurrent session's leftover dirty files, so any parallel session's WIP gave every other session a free pass. The transcript check is the only automatic pass now.

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
- **Git**: Every `kb_write` and `kb_log_decision` stages **only the files it wrote** and commits them (`git commit -m ... -- <paths>`); other sessions' staged/dirty work is untouched. Git failures surface as `git error: …` in the response, never silently swallowed
- **Index**: Auto-rebuilt after every write; titles come from the first markdown heading (frontmatter/banner-safe), SUPERSEDED docs are tagged, `inbox/` is listed
- **Security**: Path traversal protection (incl. sibling-prefix dirs like `~/knowledge-evil`); all git/grep invocations use argv arrays — no shell interpolation of user text
- **Enforcement**: Optional hooks block Claude from ending sessions without updating knowledge

## Changelog

### v1.1.2 (2026-06-11)

- **`kb_search` context lines** — `context` param (grep `-C`, default 1, 0-5): single-line hits now carry surrounding lines for usable context
- **Rotation warning** now also reminds to grep `.claude/skills` for section refs pointing at moved entries (archived-heading references go stale silently otherwise)
- **`scripts/sync.sh` in the KB repo** (not this repo) + Mac launchd / server cron: two-way ff-only sync every 15-20 min — the server clone once sat unpulled for 2 months

### v1.1.1 (2026-06-11)

- **Session-start hook v1.3** — source-aware: `resume` skips injection entirely (the original injection is already in the resumed transcript; re-injecting duplicated ~1.2k tokens). Every invocation logs `source` + bytes to `~/.claude/hooks/kb-session-start.log` so the startup/resume/clear/compact distribution can be measured before further trimming.
- **Tool descriptions trimmed** — 9 tool + verbose param descriptions cut from ~7.3KB to 5.5KB of schema (~450 tokens/session in environments that load all MCP schemas up front).

### v1.1.0 (2026-06-11)

- **Precise staging** — `git add -A` removed; tools stage only what they wrote (concurrent-session safety)
- **Writing ≠ verifying** — appends never refresh `last-verified-commit`; replace re-stamps only with `verified:true` or `codeRepo`; replace inherits existing frontmatter when the new content carries none
- **Honest drift** — unreachable baselines report ⚠️ + git error instead of false 🟢
- **Large-file reads** — `kb_read` gains `section` / `offset`+`limit` / `full`; >40KB files return a heading outline by default
- **Rotation warnings** — writes leaving a file >4000 lines / 200KB say so in the response
- **`kb_index` actually rebuilds** (previously only when `_index.md` was missing)
- **`kb_search`** fixed-string by default, `regex:true` opt-in, truncation note
- **Injection hardening** — argv arrays for git/grep; `kbPath` requires a path separator after the KB root
- **Hooks v1.2** — stop-guard drops the dirty-KB free pass; session-start injects only the index; deploy via symlink
- E2E test suite: `npm run build && node test/e2e.test.mjs` (33 checks)

## License

MIT
