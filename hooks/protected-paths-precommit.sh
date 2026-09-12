#!/bin/sh
# git pre-commit hook — AGENT-AGNOSTIC protected-path guard.
#
# Works with ANY coding agent (or human): whatever wrote the change, a commit touching a
# protected path is rejected unless an explicit unlock grant is set. This is the universal
# enforcement layer; harness-specific hooks (e.g. hooks/protected-paths.cjs for Claude Code)
# merely intercept EARLIER — this one is the backstop that always holds.
#
# Enable:
#   cp builder/hooks/protected-paths-precommit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#   (or add its body to an existing pre-commit / point core.hooksPath at a tracked hooks dir)
#
# Fill PROTECTED from PIPELINE_PROFILE.md §4 — one path prefix per line, repo-root-relative.
# Unlock (human grant, revert after merge):  BUILDER_UNLOCK=platform git commit ...

PROTECTED='
'
# Example:
# PROTECTED='
# src/platform/
# docs/
# '
# Map prefix→grant-tag for unlockable entries (space-separated "prefix:tag" pairs):
UNLOCKABLE=''
# Example: UNLOCKABLE='src/platform/:platform'

[ -z "$(printf '%s' "$PROTECTED" | tr -d '[:space:]')" ] && exit 0  # not configured → no-op

STAGED=$(git diff --cached --name-only)
FAIL=0

for prefix in $PROTECTED; do
  HITS=$(printf '%s\n' "$STAGED" | grep -E "^${prefix}" || true)
  [ -z "$HITS" ] && continue
  TAG=''
  for pair in $UNLOCKABLE; do
    case "$pair" in "${prefix}:"*) TAG="${pair#*:}";; esac
  done
  if [ -n "$TAG" ] && printf '%s' ",${BUILDER_UNLOCK}," | grep -q ",${TAG},"; then
    continue  # explicit grant present
  fi
  echo "BLOCKED: staged changes touch protected path '${prefix}' (PIPELINE_PROFILE.md §4):" >&2
  printf '%s\n' "$HITS" | sed 's/^/  - /' >&2
  [ -n "$TAG" ] && echo "  (unlockable: BUILDER_UNLOCK=${TAG} git commit ... — human grant only, revert after merge)" >&2
  FAIL=1
done

[ "$FAIL" -eq 1 ] && { echo "Protected-path edits are a boundary event — stop and ask the human." >&2; exit 1; }
exit 0
