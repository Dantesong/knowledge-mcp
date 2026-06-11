#!/usr/bin/env bash
# Stop hook: KB Drift Bot — v1.2 (2026-06-11).
#
# History:
#   v1   — block on dirty repo + no KB update
#   v2   — non-blocking pending-file trial (2026-04-27→05-01): backlog hit 119,
#          drift not solved; rolled back
#   v1.1 — v1 blocking restored + v2 improvements (COMMITS_LAST_HOUR, wider
#          excludes, session-id logging)
#   v1.2 — REMOVED the "KB repo dirty → allow" pass (option A). It couldn't
#          tell "this session updated the KB" from "a concurrent session left
#          dirty files", so any parallel session's WIP gave every other
#          session a free pass — 75 unearned allows in the log, 10 on a single
#          day. The transcript kb_write check (option B) is now the only
#          automatic pass. Manual KB edits without kb_write still block; say
#          so and ask the user, per protocol.
#          (A fine-grained per-doc code-tracks variant ("option C") lives in
#          git history at f01e3d6 — deliberately NOT deployed; re-evaluate
#          once kb_drift baselines have been honest for a month.)
#
# Deployed via symlink: ~/.claude/hooks/kb-stop-guard.sh -> this file.
# This repo copy IS the live hook — single source, no more two-version drift.
#
# Output contract:
#   Stop hooks accept ONLY {decision?, reason?, systemMessage?}.
#   Exit 0 with empty stdout = allow stop.
#   Exit 0 with JSON {"decision":"block",...} = block stop.

set -e

# -- Config --
EXCLUDED_DIRS=(
  "$HOME/knowledge"
  "$HOME/.claude"
)
KB_DIR="${KNOWLEDGE_DIR:-$HOME/knowledge}"
LOG_FILE="$HOME/.claude/hooks/kb-stop-guard.log"

# -- Read stdin JSON --
INPUT=$(cat)

CWD=$(echo "$INPUT" | /usr/bin/jq -r '.cwd // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | /usr/bin/jq -r '.transcript_path // empty' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | /usr/bin/jq -r '.session_id // empty' 2>/dev/null)
STOP_ACTIVE=$(echo "$INPUT" | /usr/bin/jq -r '.stop_hook_active // false' 2>/dev/null)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log "invoked cwd=$CWD stop_active=$STOP_ACTIVE session=$SESSION_ID"

# -- Loop guard --
if [[ "$STOP_ACTIVE" == "true" ]]; then
  log "stop_hook_active=true -> allow stop (loop guard)"
  exit 0
fi

# -- Excluded-dir guard (cwd) --
for d in "${EXCLUDED_DIRS[@]}"; do
  if [[ "$CWD" == "$d" || "$CWD" == "$d"/* ]]; then
    log "cwd in excluded dir ($d) -> allow stop"
    exit 0
  fi
done

# -- Git-repo check --
REPO_ROOT=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || echo "")

if [[ -z "$REPO_ROOT" ]]; then
  log "cwd not in a git repo -> allow stop"
  exit 0
fi

log "in git repo: $REPO_ROOT"

# -- Excluded-dir guard (repo root) --
for d in "${EXCLUDED_DIRS[@]}"; do
  if [[ "$REPO_ROOT" == "$d" || "$REPO_ROOT" == "$d"/* ]]; then
    log "repo root in excluded dir ($d) -> allow stop"
    exit 0
  fi
done

# -- Code-dirty check (working tree) --
CODE_DIRTY=$(cd "$REPO_ROOT" 2>/dev/null && \
  git status --porcelain 2>/dev/null | \
  grep -v -E '(tsconfig\.tsbuildinfo|HANDOFF\.md|\.next/|node_modules/|/dist/|/build/|\.DS_Store|\.log$|\.claude/audit-pending\.txt|\.claude/repo-map\.md)' | \
  head -30 || echo "")

# -- Recently committed (catches "session committed but didn't update KB") --
COMMITS_LAST_HOUR=$(cd "$REPO_ROOT" 2>/dev/null && \
  git log --since='1 hour ago' --oneline 2>/dev/null | head -10 || echo "")

if [[ -z "$CODE_DIRTY" && -z "$COMMITS_LAST_HOUR" ]]; then
  log "no substantive changes (working tree clean + no recent commits) -> allow stop"
  exit 0
fi

log "changes detected (dirty=${CODE_DIRTY:0:40}... commits=${COMMITS_LAST_HOUR:0:40}...)"

# -- KB-touched check: did THIS session call kb_write/kb_log_decision? --
# (v1.2: the old "KB repo dirty -> allow" pass is gone — a concurrent
#  session's uncommitted KB work is not evidence that THIS session did
#  its knowledge update.)
KB_TOOL_CALLED=0
if [[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
  if grep -q '"name":"mcp__knowledge__kb_write"\|"name":"mcp__knowledge__kb_log_decision"' "$TRANSCRIPT" 2>/dev/null; then
    KB_TOOL_CALLED=1
  fi
fi

if [[ $KB_TOOL_CALLED -eq 1 ]]; then
  log "session called kb_write/kb_log_decision -> allow stop"
  exit 0
fi

# -- Block --
log "BLOCKING stop: code dirty + no KB update (repo=$REPO_ROOT)"

REASON="You are about to stop, but the git repo at $REPO_ROOT has uncommitted code changes (or recent commits) and you have not updated the knowledge base this session.

Per the Knowledge Protocol (~/knowledge/ is the global source of truth for ALL of Dante's projects):
- If you changed code, schema, deployment, or architecture in any meaningful way, you MUST reflect it in ~/knowledge/ via the mcp__knowledge__kb_write tool.
- Significant changes also need an entry appended to the relevant development log (e.g. systems/auto-hotelier-development-log.md, systems/hotel-automation.md, etc.) describing what changed and why.
- For architectural decisions, also call mcp__knowledge__kb_log_decision.

Uncommitted files in this repo:
$CODE_DIRTY

Recent commits (last hour):
$COMMITS_LAST_HOUR

Action required:
1. If you don't know which knowledge doc the changes affect, call mcp__knowledge__kb_search with a relevant keyword. The session-start hook already injected ~/knowledge/_index.md into your context - review it.
2. Read the relevant doc via mcp__knowledge__kb_read (use {section} or {offset,limit} on large docs).
3. Update the doc via mcp__knowledge__kb_write.
4. Then you may stop.

If the changes are genuinely too trivial to warrant a knowledge update (typo fix, log message tweak, formatting only), say so explicitly to the user and ask them to confirm before stopping. Do not silently bypass this protocol."

/usr/bin/jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
exit 0
