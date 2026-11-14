#!/bin/sh
# graphify-sync git hook manager.
#
# Installs / removes a guarded block in the repo's post-merge hook that
# regenerates the local graphify graph after a merge lands on `main`. The block
# is appended AFTER any existing content (e.g. Git LFS lines) between clearly
# marked delimiters, so it coexists with other hooks and re-running install is
# idempotent.
#
# The base branches are baked into the block at install time:
#   BASE_BRANCHES="main develop" scripts/graphify/sync-hook.sh install
# (default: main). autosync.py tees its own output into the index directory's .sync.log.
#
# The block runs the session-start hook with --trigger merge, from HOOKS_JS_DIR (default .claude/hooks), where
# session-sync-hook.cjs and hook-trust.cjs must both be committed:
#   HOOKS_JS_DIR=".claude/hooks" scripts/graphify/sync-hook.sh install
#
# Usage:
#   scripts/graphify/sync-hook.sh install
#   scripts/graphify/sync-hook.sh uninstall
#   scripts/graphify/sync-hook.sh status

set -eu

HOOKS_JS_DIR="${HOOKS_JS_DIR:-.claude/hooks}"
case "$HOOKS_JS_DIR" in
  /*|*..*|*'"'*|*'$'*|*'`'*|*'\'*) echo "graphify-sync: HOOKS_JS_DIR must be a plain path relative to the repo root." >&2; exit 2 ;;
esac

BEGIN="# >>> graphify-sync >>>"
END="# <<< graphify-sync <<<"

REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO" ]; then
  echo "graphify-sync: not inside a git repository." >&2
  exit 1
fi

# Honour core.hooksPath if the repo sets one; default to .git/hooks.
HOOKS_DIR="$(git rev-parse --git-path hooks 2>/dev/null || echo "$REPO/.git/hooks")"
case "$HOOKS_DIR" in
  /*) : ;;                         # already absolute
  *) HOOKS_DIR="$REPO/$HOOKS_DIR" ;;
esac
HOOK="$HOOKS_DIR/post-merge"

_strip_block() {
  # Print $1 with any existing graphify-sync marker block removed.
  awk -v b="$BEGIN" -v e="$END" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    skip != 1 {print}
  ' "$1"
}

cmd_install() {
  mkdir -p "$HOOKS_DIR"
  if [ ! -f "$HOOK" ]; then
    printf '#!/bin/sh\n' > "$HOOK"
  fi

  # Rewrite the hook without any old block, then append a fresh one.
  tmp="$(mktemp)"
  _strip_block "$HOOK" > "$tmp"

  # Drop a trailing blank line for tidiness, then append the block.
  cat >> "$tmp" <<EOF
$BEGIN
# Auto-refresh the local graphify graph after a merge lands on a BASE branch.
# List every branch feature work merges into. In one adopting project the guard named only main while
# every feature branch merged into a development branch, so the hook essentially never fired and the
# graph sat stale for weeks while the skills and seats were routed to it.
# The merge runs autosync.py, so this trigger shares the lock and the embed limit with the others.
# Managed by scripts/graphify/sync-hook.sh — edit there, not here. Set INDEX_SYNC_SKIP=1 to disable ad hoc.
if [ -z "\${INDEX_SYNC_SKIP:-}" ]; then
  _gs_root="\$(git rev-parse --show-toplevel 2>/dev/null || true)"
  _gs_branch="\$(git symbolic-ref --short HEAD 2>/dev/null || true)"
  case " ${BASE_BRANCHES:-main} " in
    *" \$_gs_branch "*) _gs_base=1 ;;
    *) _gs_base= ;;
  esac
  if [ -n "\$_gs_root" ] && [ -n "\$_gs_base" ]; then
    # One implementation: the session-start hook, run with --trigger merge. It checks the script folder against HEAD,
    # finds its own interpreter (never a path recorded in the index directory) and spawns it isolated with a clean
    # environment. Here, before node starts it, only the hook file and hook-trust.cjs are checked: each must be a plain
    # file whose bytes are the blob at HEAD (HEAD is already the merge result, so a file the merge changed counts as committed).
    _gs_ok=1
    for _gs_f in session-sync-hook.cjs hook-trust.cjs; do
      _gs_file="\$_gs_root/${HOOKS_JS_DIR}/\$_gs_f"
      _gs_have="\$(git hash-object -- "\$_gs_file" 2>/dev/null || true)"
      _gs_head="\$(git --no-replace-objects ls-tree HEAD -- "${HOOKS_JS_DIR}/\$_gs_f" 2>/dev/null | cut -f1 | cut -d' ' -f3)"
      { [ -f "\$_gs_file" ] && [ ! -L "\$_gs_file" ] && [ -n "\$_gs_have" ] && [ "\$_gs_have" = "\$_gs_head" ]; } || _gs_ok=0
    done
    if [ "\$_gs_ok" = 1 ] && command -v node >/dev/null 2>&1; then
      # Detached: autosync.py takes its lock, syncs code, and embeds docs only within the limit. The merge never waits.
      CLAUDE_PROJECT_DIR="\$_gs_root" nohup node "\$_gs_root/${HOOKS_JS_DIR}/session-sync-hook.cjs" --trigger merge \\
        </dev/null >/dev/null 2>&1 &
    fi
  fi
fi
$END
EOF

  mv "$tmp" "$HOOK"
  chmod +x "$HOOK" 2>/dev/null || true
  echo "graphify-sync: installed into $HOOK"
}

cmd_uninstall() {
  if [ ! -f "$HOOK" ]; then
    echo "graphify-sync: no post-merge hook — nothing to remove."
    return 0
  fi
  tmp="$(mktemp)"
  _strip_block "$HOOK" > "$tmp"
  mv "$tmp" "$HOOK"
  chmod +x "$HOOK" 2>/dev/null || true
  echo "graphify-sync: removed block from $HOOK (other hook content preserved)."
}

cmd_status() {
  if [ -f "$HOOK" ] && grep -qF "$BEGIN" "$HOOK"; then
    echo "hook:    INSTALLED ($HOOK)"
  else
    echo "hook:    not installed"
  fi
  pending="$REPO/graphify-out/.needs_semantic_sync.json"
  if [ -f "$pending" ]; then
    n="$(grep -c '"' "$pending" 2>/dev/null || echo '?')"
    echo "docs:    pending semantic re-embed — see $pending"
  else
    echo "docs:    none pending"
  fi
  if [ -f "$REPO/graphify-out/graph.json" ]; then
    echo "graph:   present"
  else
    echo "graph:   MISSING — run a full /graphify first"
  fi
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  *)
    echo "usage: $0 {install|uninstall|status}" >&2
    exit 2
    ;;
esac
