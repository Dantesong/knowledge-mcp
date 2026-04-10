#!/usr/bin/env bash
# Stop hook: enforce knowledge base updates for ANY code-modifying session.
#
# Philosophy:
#   ~/knowledge/ is the global source of truth for all of Dante's projects.
#   Any session that modifies code in any git repo should also update knowledge.
#   This is a global enforcement, not project-scoped.
#
# Logic:
#   1. Read JSON from stdin (cwd, transcript_path, stop_hook_active)
#   2. Loop guard: if stop_hook_active=true, exit 0 (allow stop)
#   3. Excluded-dir guard: knowledge/CC config dirs don't need to write to themselves
#   4. Git-repo check: cwd must be inside a git repo (else nothing to track)
#   5. Code-dirty check: git status --porcelain in repo root, ignore noise
#   6. KB-touched check: did this session call kb_write/kb_log_decision,
#      OR is ~/knowledge/ itself dirty?
#   7. If code dirty AND kb not touched -> emit JSON {decision:block, reason:...}
#      Otherwise exit 0.
#
# Output contract:
#   Stop hooks accept ONLY {decision?, reason?, systemMessage?} - no other fields.
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
STOP_ACTIVE=$(echo "$INPUT" | /usr/bin/jq -r '.stop_hook_active // false' 2>/dev/null)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log "invoked cwd=$CWD stop_active=$STOP_ACTIVE"

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

# -- Code-dirty check --
CODE_DIRTY=$(cd "$REPO_ROOT" 2>/dev/null && \
  git status --porcelain 2>/dev/null | \
  grep -v -E '(tsconfig\.tsbuildinfo|HANDOFF\.md|\.next/|node_modules/|/dist/|/build/|\.DS_Store|\.log$)' | \
  head -30 || echo "")

if [[ -z "$CODE_DIRTY" ]]; then
  log "no substantive code changes -> allow stop"
  exit 0
fi

log "code dirty detected"

# -- KB-touched check (option A: knowledge repo dirty) --
KB_DIRTY=$(cd "$KB_DIR" 2>/dev/null && \
  git status --porcelain 2>/dev/null | \
  grep -v -E '\.DS_Store' || echo "")

if [[ -n "$KB_DIRTY" ]]; then
  log "knowledge repo is dirty -> user already updated KB -> allow stop"
  exit 0
fi

# -- KB-touched check (option B: this session called kb_write/kb_log_decision) --
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

REASON="You are about to stop, but the git repo at $REPO_ROOT has uncommitted code changes and you have not updated the knowledge base this session.

Per the Knowledge Protocol (~/knowledge/ is the global source of truth for ALL of Dante's projects):
- If you changed code, schema, deployment, or architecture in any meaningful way, you MUST reflect it in ~/knowledge/ via the mcp__knowledge__kb_write tool.
- Significant changes also need an entry appended to the relevant development log (e.g. systems/pms-development-log.md, systems/hotel-automation.md, etc.) describing what changed and why.
- For architectural decisions, also call mcp__knowledge__kb_log_decision.
- After kb_write, run mcp__knowledge__kb_index to rebuild the index.

Uncommitted files in this repo:
$CODE_DIRTY

Action required:
1. If you don't know which knowledge doc the changes affect, call mcp__knowledge__kb_search with a relevant keyword. The session-start hook already injected ~/knowledge/_index.md into your context - review it.
2. Read the relevant doc via mcp__knowledge__kb_read to see current contents.
3. Update the doc via mcp__knowledge__kb_write.
4. Rebuild the index via mcp__knowledge__kb_index.
5. Then you may stop.

If the changes are genuinely too trivial to warrant a knowledge update (typo fix, log message tweak, formatting only), say so explicitly to the user and ask them to confirm before stopping. Do not silently bypass this protocol."

/usr/bin/jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
exit 0
