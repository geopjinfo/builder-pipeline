#!/bin/sh
# Mechanical file placement for the builder kit — the no-Node fallback.
# Usage:  sh builder/scripts/unpack.sh <claude-code|codex>   (run from the TARGET repo root)
# folder-layout: this whole file — it runs from a builder/ folder copy, so its commands are the folder forms.
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

# Common ledgers + profile (all harnesses).
#
# This fallback cannot read §16 `paths` — no JSON parser is guaranteed in /bin/sh — so it installs the
# ledgers at the kit's defaults, which is right exactly once: on a FIRST install, before a profile exists.
# A profile already present means the ledgers do too, at the defaults or wherever §16 moved them; copying
# again could only add a blank twin at the default beside the real one, which every checker reads §16 and
# passes over in silence. So the ledgers are skipped there, and the CLI — which does read §16 — is named.
copy "$KIT/templates/module-brief.md"       "specs/module-brief.template.md"
if [ -e PIPELINE_PROFILE.md ]; then
  echo "skip (profile present): ledgers — this fallback cannot read §16 paths; run 'node builder/cli.js unpack' for"
  echo "                        any ledger this kit version adds, then 'node builder/cli.js verify'"
else
  copy "$KIT/templates/task-board.md"         "tasks/README.md"
  copy "$KIT/templates/session-board.md"      "tasks/_session-board.template.md"
  copy "$KIT/templates/deferred-registry.md"  "DEFERRED_TASKS.md"
  copy "$KIT/templates/decision-log.md"       "DECISIONS.md"
  copy "$KIT/PIPELINE_PROFILE.template.md"    "PIPELINE_PROFILE.md"
fi

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
