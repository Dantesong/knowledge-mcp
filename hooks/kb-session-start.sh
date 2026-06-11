#!/usr/bin/env bash
# SessionStart hook: inject the KB index as additional context.
# stdout is added to Claude's context by Claude Code.
# Keep this fast — SessionStart runs on every session (startup/resume/clear/compact).
#
# v1.2 (2026-06-11): dropped the ~1.4KB protocol-rules header that duplicated
# the Knowledge Protocol section already in ~/.claude/CLAUDE.md verbatim —
# every session was paying for the same rules twice. Only the index (the part
# CLAUDE.md can't carry) is injected now.
#
# Deployed via symlink: ~/.claude/hooks/kb-session-start.sh -> this file.

set -e

KB_DIR="${KNOWLEDGE_DIR:-$HOME/knowledge}"
INDEX="$KB_DIR/_index.md"

if [[ ! -f "$INDEX" ]]; then
  echo "[knowledge-protocol] index not found at $INDEX - skipping injection" >&2
  exit 0
fi

cat << 'HEADER'
=== KNOWLEDGE BASE INDEX ===
(Knowledge Protocol rules are in your global CLAUDE.md. Below is the live
catalog of ~/knowledge/ docs — fetch any of them with mcp__knowledge__kb_read;
large docs return an outline first, use {section} or {offset,limit}.)

HEADER

cat "$INDEX"

echo ""
echo "=== END KNOWLEDGE BASE INDEX ==="
