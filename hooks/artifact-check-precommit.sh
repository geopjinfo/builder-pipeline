#!/bin/sh
# git pre-commit hook — the index is checked for junk before the commit (specs/repo-hygiene.spec.md REQ-1843, D101).
#
# Runs `artifact-check --staged` over the staged files (git diff --cached): an assistant-specific file, a scratch file,
# an archive, an assistant line in .gitignore or a generated-content label refuses the commit with the finding and the
# command a person would run. What a blanket `git add -A` picked up is caught here, before it becomes history.
# There is no unlock variable: `features.artifactCheck.allow` in PIPELINE_PROFILE.md §16 is the only way past it.
# With the feature off the check prints "artifactCheck: not configured" and the commit goes through (exit 3 is not a
# refusal here: an unconfigured check never decides).
#
# Arm it (each clone; git hooks are not pushed): `npx builder-pipeline git-hooks --artifact-check` copies it to the
# repository's hooks folder as `pre-commit` (never over a hook already there) and fills KIT below.
# By hand: copy it to .git/hooks/pre-commit (or your core.hooksPath directory), make it executable, set KIT.
# (folder layout: node builder/cli.js git-hooks --artifact-check)

KIT=''
# Example (package layout): KIT='node_modules/builder-pipeline'   Example (folder layout): KIT='builder'

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
command -v node >/dev/null 2>&1 || exit 0

if [ -n "$KIT" ] && [ -f "$ROOT/$KIT/scripts/artifact-check.mjs" ]; then
  SCRIPT="$ROOT/$KIT/scripts/artifact-check.mjs"
elif [ -f "$ROOT/node_modules/builder-pipeline/scripts/artifact-check.mjs" ]; then
  SCRIPT="$ROOT/node_modules/builder-pipeline/scripts/artifact-check.mjs"
elif [ -f "$ROOT/builder/scripts/artifact-check.mjs" ]; then
  SCRIPT="$ROOT/builder/scripts/artifact-check.mjs"
elif [ -f "$ROOT/scripts/artifact-check.mjs" ]; then
  SCRIPT="$ROOT/scripts/artifact-check.mjs"
else
  exit 0
fi

cd "$ROOT" || exit 0
node "$SCRIPT" --staged
status=$?
case "$status" in
  0|3) exit 0 ;;
  1) echo "pre-commit: artifact-check refused the commit — unstage the paths above (git rm --cached PATH) or add an allow entry to features.artifactCheck in PIPELINE_PROFILE.md §16" >&2; exit 1 ;;
  *) echo "pre-commit: artifact-check could not run (exit $status); the commit goes through" >&2; exit 0 ;;
esac
