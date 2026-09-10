#!/bin/sh
# Mechanical file placement for the builder kit.
# Usage:  sh builder/scripts/unpack.sh <claude-code|codex>   (run from the TARGET repo root)
# Copies only; never overwrites an existing file. Filling PIPELINE_PROFILE.md and harness
# wiring (CLAUDE.md / AGENTS.md lines, model tiers, .gitignore) stay on you / your agent —
# see builder/UNPACK.md.

set -eu

TARGET="${1:-}"
KIT="$(dirname "$0")/.."

[ -d "$KIT/agents" ] || { echo "error: run from the repo root containing builder/"; exit 1; }

copy() { # copy <src> <dst> — skip if dst exists
  if [ -e "$2" ]; then echo "skip (exists): $2"; else
    mkdir -p "$(dirname "$2")"; cp "$1" "$2"; echo "installed:     $2"
  fi
}

case "$TARGET" in
  claude-code)
    for f in "$KIT"/agents/*.md; do copy "$f" ".claude/agents/$(basename "$f")"; done
    for s in build-module-pipeline scaffold-module module-readiness-check setup-builder; do
      copy "$KIT/skills/$s.md" ".claude/skills/$s/SKILL.md"
    done
    ;;
  codex)
    for f in "$KIT"/agents/*.md; do copy "$f" ".builder/personas/$(basename "$f")"; done
    for f in "$KIT"/skills/*.md; do copy "$f" ".builder/playbooks/$(basename "$f")"; done
    ;;
  *)
    echo "usage: unpack.sh <claude-code|codex>"; exit 1;;
esac

# Common ledgers + profile (all harnesses)
copy "$KIT/templates/task-board.md"         "tasks/README.md"
copy "$KIT/templates/deferred-registry.md"  "DEFERRED_TASKS.md"
copy "$KIT/templates/module-brief.md"       "specs/module-brief.template.md"
copy "$KIT/PIPELINE_PROFILE.template.md"    "PIPELINE_PROFILE.md"

# Board tooling: the computed progress bar, its CI gate, and the rendered run board + watcher.
# Shipping the board RULES without these leaves both unenforceable — a typed bar is a claim nobody
# re-derives, and a page nobody re-renders is stale without saying so.
for f in board-progress.mjs board-check-all.mjs board-render.mjs board-watch.mjs; do
  copy "$KIT/scripts/$f" "scripts/$f"
done
for f in board-rows.cjs board-parse.cjs run-log.cjs transcript-usage.cjs pricing.cjs board-freshness.cjs; do
  copy "$KIT/scripts/lib/$f" "scripts/lib/$f"
done

grep -qs '^\.pipeline/$' .gitignore 2>/dev/null || echo "note: add '.pipeline/' to .gitignore"
echo "done. Next: fill PIPELINE_PROFILE.md and finish the wiring steps in builder/UNPACK.md."
