#!/usr/bin/env bash
# SessionStart hook: inject the KB index as additional context.
# stdout is added to Claude's context by Claude Code.
# Keep this fast — SessionStart runs on every session (startup/resume/clear/compact).
#
# v1.3 (2026-06-11): source-aware injection + measurement log.
#   - source=resume → silent exit. The original injection is already in the
#     resumed transcript's context; re-injecting duplicates ~1.2k tokens
#     (docs: resume re-runs SessionStart to refresh *stale* context like
#     timestamps — a static index has nothing to refresh).
#   - source=compact → still emits. Today a known bug (#15174) drops
#     SessionStart stdout after compaction, so this costs nothing; when the
#     bug is fixed, re-injection after compact is desirable (the pre-compact
#     injection does not survive summarization).
#   - Every invocation logs "timestamp source bytes" to kb-session-start.log
#     so the startup/resume/clear/compact distribution can be measured before
#     deciding on further trimming (e.g. cwd-scoped index filtering).
# v1.2 (2026-06-11): dropped the ~1.4KB protocol-rules header that duplicated
# the Knowledge Protocol section already in ~/.claude/CLAUDE.md verbatim.
#
# Deployed via symlink: ~/.claude/hooks/kb-session-start.sh -> this file.

set -e

KB_DIR="${KNOWLEDGE_DIR:-$HOME/knowledge}"
INDEX="$KB_DIR/_index.md"
LOG_FILE="$HOME/.claude/hooks/kb-session-start.log"

INPUT=$(cat 2>/dev/null || true)
SOURCE=$(echo "$INPUT" | /usr/bin/jq -r '.source // "unknown"' 2>/dev/null || echo "unknown")
[[ -z "$SOURCE" ]] && SOURCE="unknown"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] source=$SOURCE bytes=$1" >> "$LOG_FILE"
}

if [[ "$SOURCE" == "resume" ]]; then
  log 0
  exit 0
fi

if [[ ! -f "$INDEX" ]]; then
  echo "[knowledge-protocol] index not found at $INDEX - skipping injection" >&2
  log 0
  exit 0
fi

OUTPUT=$(cat << 'HEADER'
=== KNOWLEDGE BASE INDEX ===
(Knowledge Protocol rules are in your global CLAUDE.md. Below is the live
catalog of ~/knowledge/ docs — fetch any of them with mcp__knowledge__kb_read;
large docs return an outline first, use {section} or {offset,limit}.)

HEADER
cat "$INDEX"
echo ""
echo "=== END KNOWLEDGE BASE INDEX ===")

log "$(printf '%s' "$OUTPUT" | wc -c | tr -d ' ')"
printf '%s\n' "$OUTPUT"
