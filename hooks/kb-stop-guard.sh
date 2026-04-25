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

# -- Fine-grained check (option C, since 2026-04-25): doc-frontmatter linkage --
#
# If a KB doc has frontmatter `code-repo: <repo>`, and this session changed
# files in <repo>, AND those changed files match the doc's `code-tracks`
# patterns, AND the doc was NOT kb_write'n this session — then list the doc
# as "should-update". Block iff the should-update list is non-empty.
#
# This catches the failure mode: developer changes schema.prisma but only
# updates development-log; database.md stays stale. Old hook was satisfied
# (kb_write was called); new hook recognises database.md tracks
# packages/db/prisma/schema.prisma and demands an update there too.

# Collect changed file paths (relative to repo root)
CHANGED_FILES=$(cd "$REPO_ROOT" 2>/dev/null && \
  git status --porcelain 2>/dev/null | \
  awk '{$1=""; print substr($0,2)}' | \
  grep -vE '(tsconfig\.tsbuildinfo|HANDOFF\.md|\.next/|node_modules/|/dist/|/build/|\.DS_Store|\.log$)' || echo "")

# Helper: parse `code-repo:` value from frontmatter (lines 2-30 of file).
# Returns empty string if not set or no frontmatter.
parse_fm_field() {
  local file="$1"
  local field="$2"
  awk -v f="$field" '
    NR==1 && $0!="---" { exit }
    NR==1 && $0=="---" { in_fm=1; next }
    in_fm && $0=="---" { exit }
    in_fm && $0 ~ "^"f":" {
      sub("^"f":[[:space:]]*","")
      print
      exit
    }
  ' "$file"
}

# For each KB doc, check if it tracks this repo + tracks changed files.
SHOULD_UPDATE=()
if [[ -d "$KB_DIR/systems" ]] && [[ -n "$CHANGED_FILES" ]]; then
  for doc in "$KB_DIR"/systems/*.md "$KB_DIR"/ops/*.md; do
    [[ -f "$doc" ]] || continue
    DOC_REPO=$(parse_fm_field "$doc" "code-repo")
    [[ -z "$DOC_REPO" ]] && continue
    [[ "$DOC_REPO" != "$REPO_ROOT" ]] && continue

    # code-tracks: JSON array `["a","b"]` or `[a,b]`
    DOC_TRACKS_RAW=$(parse_fm_field "$doc" "code-tracks")
    # Normalize: strip [ ], "", split by comma
    DOC_TRACKS=$(echo "$DOC_TRACKS_RAW" | sed 's/[][]//g; s/"//g; s/,/\n/g' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || echo "")

    # Empty code-tracks = whole repo → any change matches
    MATCHED=0
    if [[ -z "$DOC_TRACKS" ]]; then
      MATCHED=1
    else
      while IFS= read -r track; do
        [[ -z "$track" ]] && continue
        # If any changed file starts with $track (or matches $track if track is a file)
        if echo "$CHANGED_FILES" | grep -qE "^${track}(/|$)"; then
          MATCHED=1
          break
        fi
      done <<< "$DOC_TRACKS"
    fi

    [[ $MATCHED -eq 0 ]] && continue

    # Did this session kb_write to this specific doc?
    DOC_REL="${doc#$KB_DIR/}"
    DOC_TOUCHED=0
    if [[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
      # Look for kb_write call with this exact path in the transcript
      if grep -qF "\"path\":\"$DOC_REL\"" "$TRANSCRIPT" 2>/dev/null && \
         grep -q '"name":"mcp__knowledge__kb_write"\|"name":"mcp__knowledge__kb_link_track"' "$TRANSCRIPT" 2>/dev/null; then
        DOC_TOUCHED=1
      fi
    fi

    [[ $DOC_TOUCHED -eq 1 ]] && continue

    SHOULD_UPDATE+=("$DOC_REL")
  done
fi

if [[ ${#SHOULD_UPDATE[@]} -gt 0 ]]; then
  log "BLOCKING stop: doc-frontmatter linkage detected ${#SHOULD_UPDATE[@]} stale doc(s)"

  STALE_LIST=$(printf "  - %s\n" "${SHOULD_UPDATE[@]}")
  REASON_FINE="You changed code in $REPO_ROOT, and the following KB doc(s) are linked to those code paths via frontmatter \`code-tracks\` but were NOT updated this session:

$STALE_LIST

These docs are explicitly tracking what you just changed — leaving them un-updated produces the long-term staleness gap we keep hitting. Review them with mcp__knowledge__kb_drift to see what changed since their last verification.

Action required (per linked doc):
1. mcp__knowledge__kb_read to see current content
2. Decide: update the doc to reflect the new reality, OR mcp__knowledge__kb_drift with bump=true if the change doesn't actually affect the doc's claims
3. mcp__knowledge__kb_write to commit the updated content (this auto-stamps last-verified-commit)

If the changes are genuinely irrelevant to the linked docs, run mcp__knowledge__kb_drift with bump=true on each to baseline the new HEAD without changing content. Then you may stop.

Override (use sparingly): if you've already documented the changes elsewhere (e.g. development-log) and the linked docs genuinely don't need an update, say so explicitly to the user and ask them to confirm before stopping."

  /usr/bin/jq -n --arg reason "$REASON_FINE" '{decision: "block", reason: $reason}'
  exit 0
fi

# -- Coarse fallback: any kb_write/log_decision satisfies (unchanged behaviour) --
if [[ $KB_TOOL_CALLED -eq 1 ]]; then
  log "session called kb_write/kb_log_decision (no fine-grained block) -> allow stop"
  exit 0
fi

# -- Block (coarse): code dirty + zero KB activity --
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
2. Better: link the relevant doc to this repo via mcp__knowledge__kb_link_track (one-time setup per doc) so future sessions get fine-grained drift detection.
3. Read the relevant doc via mcp__knowledge__kb_read to see current contents.
4. Update the doc via mcp__knowledge__kb_write (pass codeRepo to auto-stamp last-verified-commit).
5. Rebuild the index via mcp__knowledge__kb_index.
6. Then you may stop.

If the changes are genuinely too trivial to warrant a knowledge update (typo fix, log message tweak, formatting only), say so explicitly to the user and ask them to confirm before stopping. Do not silently bypass this protocol."

/usr/bin/jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
exit 0
