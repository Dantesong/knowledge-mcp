#!/usr/bin/env bash
# SessionStart hook: inject knowledge base index as additional context.
# stdout is added to Claude's context by Claude Code.
# Keep this fast - SessionStart runs on every session (startup/resume/clear/compact).

set -e

KB_DIR="${KNOWLEDGE_DIR:-$HOME/knowledge}"
INDEX="$KB_DIR/_index.md"

if [[ ! -f "$INDEX" ]]; then
  echo "[knowledge-protocol] index not found at $INDEX - skipping injection" >&2
  exit 0
fi

cat << 'HEADER'
=== KNOWLEDGE BASE PROTOCOL (MANDATORY - GLOBAL) ===

The user maintains a single global knowledge base at ~/knowledge/ which is the
SOURCE OF TRUTH for ALL projects - architecture, system design, ops runbooks,
decisions. Every project shares this one knowledge base.

RULES (apply to every git repo, not just one project):

1. BEFORE modifying code/schema/deployment in any git repo, READ the relevant
   knowledge docs using `mcp__knowledge__kb_read` or `mcp__knowledge__kb_search`.
   The full index is below - use it to find the right doc.

2. AFTER completing meaningful changes, UPDATE knowledge via `mcp__knowledge__kb_write`
   and append an entry to the relevant development log (e.g.
   systems/pms-development-log.md, or the equivalent for whichever system you touched).
   Then call `mcp__knowledge__kb_index` to rebuild the index.

3. ENFORCEMENT: A Stop hook checks the cwd's git repo state when you try to end
   the session. If the repo has uncommitted real changes but no knowledge update
   was made, the hook will BLOCK the stop and require you to update knowledge
   first. The only excluded dirs are ~/knowledge/ itself and ~/.claude/.

4. TRIVIAL CHANGES (typo, log tweak, formatting only) don't need a knowledge
   update - if the Stop hook blocks you on something trivial, tell the user
   explicitly and ask for confirmation before stopping.

Below is the current ~/knowledge/_index.md (the catalog of all docs).
Use `mcp__knowledge__kb_read` to fetch any individual file's contents.

HEADER

cat "$INDEX"

echo ""
echo "=== END KNOWLEDGE BASE PROTOCOL ==="
