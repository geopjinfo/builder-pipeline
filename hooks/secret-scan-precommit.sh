#!/bin/sh
# git pre-commit hook — AGENT-AGNOSTIC secret scan (REQ-1815; D88). Works with ANY coding agent, or a person: the staged
# added lines (`git diff --cached -U0`) are scanned with the kit's secret SHAPES through scripts/lib/secret-scan.cjs,
# run as data by node. A hit rejects the commit and names the kind and the file, never the text. No unlock variable
# exists: the profile's `features.secretScan.allow` list (PIPELINE_PROFILE.md §16) is the only exception.
#
# Arm it (each clone; git hooks are not pushed):
#   npx --no-install builder-pipeline git-hooks --secret-scan
# copies this file to the repository's hooks folder as `pre-commit` (never over a pre-commit already there: it names
# the line to add) and fills KIT_LIB below with the kit's lib folder. By hand: copy it, make it executable, fill KIT_LIB.
#
# The lib is looked for, in order: KIT_LIB, the project's scripts/lib (folder layout), the copy vendored beside the
# Claude Code hooks (.claude/hooks/kit/lib), the kit copied in as builder/. Not found, or no node → the commit goes
# through with one line on stderr: a hook that cannot judge never guesses.

KIT_LIB=''

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
LIB=''
for candidate in "$KIT_LIB" "$ROOT/scripts/lib" "$ROOT/.claude/hooks/kit/lib" "$ROOT/builder/scripts/lib"; do
  [ -n "$candidate" ] && [ -f "$candidate/secret-scan.cjs" ] && { LIB="$candidate"; break; }
done
if [ -z "$LIB" ] || ! command -v node >/dev/null 2>&1; then
  echo "secret-scan pre-commit: scripts/lib/secret-scan.cjs (or node) not found — the commit goes through unscanned" >&2
  exit 0
fi

node -e '
const lib = require(process.argv[1]);
process.exit(lib.precommit(process.argv[2]));
' "$LIB/secret-scan.cjs" "$ROOT"
