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
# Usage:
#   scripts/graphify/sync-hook.sh install
#   scripts/graphify/sync-hook.sh uninstall
#   scripts/graphify/sync-hook.sh status

set -eu

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
    # Strip a UTF-8 BOM (PowerShell writes one) and CR/LF from the saved path.
    _gs_py="\$(cat "\$_gs_root/graphify-out/.graphify_python" 2>/dev/null | tr -d '\357\273\277\r\n' || true)"
    if [ -n "\$_gs_py" ] && [ -f "\$_gs_py" ]; then
      nohup "\$_gs_py" "\$_gs_root/scripts/graphify/autosync.py" --trigger merge \\
        >/dev/null 2>&1 &
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
