#!/bin/sh
# Mechanical file placement for the builder kit — the no-Node fallback.
# Usage:  sh builder/scripts/unpack.sh <claude-code|codex>   (run from the TARGET repo root)
# The scripts it installs need Node 18+ to run. `node builder/cli.js unpack` is the complete
# installer (agent frontmatter transform, hooks, skill references, experimental files); use this
# only where the CLI cannot run.
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

# copy_tree <src-dir> <dst-dir> [excluded top-level file names…] — every file, recursively,
# same relative paths, copy-if-absent.
copy_tree() {
  src="$1"; dst="$2"; shift 2
  [ -d "$src" ] || return 0
  find "$src" -type f | sort | while IFS= read -r f; do
    rel="${f#"$src"/}"
    skip=0
    for x in "$@"; do [ "$rel" = "$x" ] && skip=1; done
    [ "$skip" -eq 1 ] || copy "$f" "$dst/$rel"
  done
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

# Scripts: the board tooling (computed progress bar, its CI gate, the rendered run board + watcher),
# the checkers, and every library they share. The whole tree is copied, not a hand-kept list: a list
# goes stale the moment a script gains a require, and the fallback then installs a board that cannot
# render. Shipping the board RULES without these leaves both unenforceable — a typed bar is a claim
# nobody re-derives, and a page nobody re-renders is stale without saying so.
copy_tree "$KIT/scripts" "scripts" unpack.sh unpack.ps1
# Contract-oracle adapters: the oracle script looks in scripts/oracles/.
copy_tree "$KIT/oracles" "scripts/oracles"

grep -qs '^\.pipeline/$' .gitignore 2>/dev/null || echo "note: add '.pipeline/' to .gitignore"
echo "done. Next: fill PIPELINE_PROFILE.md and finish the wiring steps in builder/UNPACK.md."
