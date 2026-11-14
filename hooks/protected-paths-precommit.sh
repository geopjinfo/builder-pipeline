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
# PIPELINE_PROFILE.md §16 `protected` globs are read too (with node, as data) and only ADD prefixes:
# each glob becomes the directory before its first wildcard, exactly as hooks/protected-paths.cjs reads
# it. No node, no profile, no block, or a malformed one = nothing added.
# A prefix is matched LITERALLY (a shell `case` with the prefix quoted), never as a regular expression.
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

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
FROM_PROFILE=''
if [ -f "$ROOT/PIPELINE_PROFILE.md" ] && command -v node >/dev/null 2>&1; then
  FROM_PROFILE=$(node -e '
const fs = require("fs");
try {
  const text = fs.readFileSync(process.argv[1], "utf8");
  if (Buffer.byteLength(text) > 1024 * 1024) process.exit(0);
  const blocks = [...text.matchAll(/```json[ \t]+pipeline-settings[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
  if (blocks.length !== 1) process.exit(0);
  const raw = JSON.parse(blocks[0][1]);
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.protected : undefined;
  if (!Array.isArray(list) || !list.every((g) => typeof g === "string")) process.exit(0);
  for (const g of list) {
    let p = g.trim().replace(/[\\/]+/g, "/").replace(/^(?:\.\/)+/, "");
    if (!p || /[<>]/.test(p) || p.startsWith("!") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) continue;
    const wild = p.search(/[*?[\]{}]/);
    if (wild !== -1) p = p.slice(0, p.slice(0, wild).lastIndexOf("/") + 1);
    if (!/^\.?\/?$/.test(p)) console.log(p);
  }
} catch (_) {}
' "$ROOT/PIPELINE_PROFILE.md" 2>/dev/null || true)
fi

ALL=$(printf '%s\n%s\n' "$PROTECTED" "$FROM_PROFILE")
[ -z "$(printf '%s' "$ALL" | tr -d '[:space:]')" ] && exit 0  # not configured → no-op

STAGED=$(git diff --cached --name-only)
FAIL=0

while IFS= read -r prefix; do
  prefix=$(printf '%s' "$prefix" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$prefix" ] && continue
  HITS=''
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      "$prefix"*) HITS="${HITS}${file}
" ;;
    esac
  done <<EOF
$STAGED
EOF
  [ -z "$HITS" ] && continue
  TAG=''
  for pair in $UNLOCKABLE; do
    case "$pair" in "${prefix}:"*) TAG="${pair#*:}";; esac
  done
  if [ -n "$TAG" ]; then
    case ",${BUILDER_UNLOCK}," in
      *",${TAG},"*) continue ;;  # explicit grant present
    esac
  fi
  echo "BLOCKED: staged changes touch protected path '${prefix}' (PIPELINE_PROFILE.md §4/§16):" >&2
  printf '%s' "$HITS" | sed 's/^/  - /' >&2
  [ -n "$TAG" ] && echo "  (unlockable: BUILDER_UNLOCK=${TAG} git commit ... — human grant only, revert after merge)" >&2
  FAIL=1
done <<EOF
$ALL
EOF

[ "$FAIL" -eq 1 ] && { echo "Protected-path edits are a boundary event — stop and ask the human." >&2; exit 1; }
exit 0
