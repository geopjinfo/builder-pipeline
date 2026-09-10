#!/usr/bin/env python3
"""graphify auto-sync worker — incremental, token-free graph regeneration.

Invoked automatically by the post-merge git hook (see sync-hook.sh) and manually
by the /graphify-sync skill. Re-extracts ONLY changed code files via AST (zero
LLM tokens), merges them into the existing graph, and preserves the human-written
community labels. Changed docs are recorded for a deferred semantic pass and are
never sent to an LLM here.

Exit codes:
  0  synced (or nothing to do)
  10 synced, but docs changed and are pending semantic re-embed
  3  no graph.json yet — run a full /graphify first
  1  error
"""

import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

# Windows consoles default to cp1252; graph summaries and log lines must not
# crash on non-ASCII. Force UTF-8 stdout/stderr where the runtime supports it.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

# Resolve the repo root from this file's location (scripts/graphify/sync.py),
# so the worker is correct regardless of the cwd the git hook runs it in.
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "graphify-out"
GRAPH = OUT / "graph.json"
LABELS = OUT / ".graphify_labels.json"
PENDING = OUT / ".needs_semantic_sync.json"

# Extensions graphify extracts structurally (AST) — everything else is "doc"
# and needs semantic extraction, which we defer.
CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java",
    ".cpp", ".c", ".cc", ".cxx", ".hpp", ".h", ".rb", ".swift", ".kt", ".kts",
    ".cs", ".scala", ".php", ".lua",
}


def _log(msg: str) -> None:
    print("[graphify-sync] " + msg, flush=True)


def _record_pending_docs(docs: list[str]) -> None:
    """Append changed doc paths to the deferred-semantic flag file (deduped)."""
    existing: set[str] = set()
    if PENDING.exists():
        try:
            existing = set(json.loads(PENDING.read_text(encoding="utf-8")).get("files", []))
        except Exception:
            existing = set()
    existing.update(docs)
    PENDING.write_text(
        json.dumps({"files": sorted(existing)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> int:
    os.chdir(ROOT)

    if not GRAPH.exists():
        _log("No graph.json yet — run a full /graphify before enabling auto-sync.")
        return 3

    try:
        from graphify.analyze import god_nodes, suggest_questions, surprising_connections
        from graphify.build import build_merge
        from graphify.cluster import score_all
        from graphify.detect import detect_incremental, save_manifest
        from graphify.export import to_json
        from graphify.extract import collect_files, extract
        from graphify.report import generate
    except Exception as exc:  # graphify not importable — never block the merge
        _log(f"graphify not importable ({exc}). Skipping.")
        return 1

    # 1. What changed since the last graph state? (AST-hash based)
    inc = detect_incremental(ROOT, kind="ast")
    new_files = inc.get("new_files", {}) or {}
    deleted = list(inc.get("deleted_files", []) or [])
    changed = [f for lst in new_files.values() for f in lst]

    if not changed and not deleted:
        _log("Nothing changed since the last sync.")
        return 0

    changed_code = [f for f in changed if Path(f).suffix.lower() in CODE_EXTS]
    changed_docs = [f for f in changed if Path(f).suffix.lower() not in CODE_EXTS]

    if changed_docs:
        _record_pending_docs(changed_docs)

    # 2. AST-extract only the changed code files (zero tokens).
    code_paths: list[Path] = []
    for f in changed_code:
        p = Path(f)
        code_paths.extend(collect_files(p) if p.is_dir() else [p])

    if code_paths:
        ast = extract(code_paths, cache_root=ROOT)
    else:
        ast = {"nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}

    # 3. Capture the old community/label mapping BEFORE the merge so we can
    #    preserve human-written labels instead of re-clustering.
    old = json.loads(GRAPH.read_text(encoding="utf-8"))
    old_comm = {n["id"]: n.get("community") for n in old.get("nodes", [])}
    labels: dict[int, str] = {}
    if LABELS.exists():
        try:
            labels = {int(k): v for k, v in json.loads(LABELS.read_text(encoding="utf-8")).items()}
        except Exception:
            labels = {}

    # 4. Merge changed code into the existing graph; prune deleted files.
    #    Docs are NOT in `ast`, so their existing nodes are preserved untouched
    #    until the deferred semantic pass runs.
    G = build_merge(
        [ast],
        graph_path=str(GRAPH),
        prune_sources=deleted or None,
        root=str(ROOT),
        directed=False,
    )

    # 5. Rebuild the community map, preserving labels. New nodes inherit the
    #    community of their highest-degree already-labeled neighbour; orphans
    #    land in an "Unsorted (pending recluster)" bucket.
    known_cids = [c for c in old_comm.values() if isinstance(c, int)]
    unsorted_cid = (max(known_cids) + 1) if known_cids else 0

    node_comm: dict[str, int] = {}
    for n in G.nodes():
        c = old_comm.get(n)
        if isinstance(c, int):
            node_comm[n] = c

    for n in G.nodes():
        if n in node_comm:
            continue
        neigh = Counter(node_comm[m] for m in G.neighbors(n) if m in node_comm)
        node_comm[n] = neigh.most_common(1)[0][0] if neigh else unsorted_cid

    communities: dict[int, list[str]] = {}
    for n, c in node_comm.items():
        communities.setdefault(c, []).append(n)

    if unsorted_cid in communities and unsorted_cid not in labels:
        labels[unsorted_cid] = "Unsorted (pending recluster)"

    # 6. Regenerate outputs (report + graph.json), preserving labels.
    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)
    detection = {
        "total_files": inc.get("total_files", 0),
        "total_words": inc.get("total_words", 0),
        "files": inc.get("files", {}),
    }
    tokens = {"input": 0, "output": 0}

    to_json(G, communities, str(GRAPH), force=True, community_labels=labels)
    report = generate(
        G, communities, cohesion, labels, gods, surprises, detection, tokens,
        str(ROOT), suggested_questions=questions,
    )
    (OUT / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    LABELS.write_text(
        json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False),
        encoding="utf-8",
    )

    # 7. Save the manifest so the NEXT merge diffs against this state. kind="ast"
    #    stamps ast_hash and clears semantic_hash for changed docs, keeping them
    #    flagged for the deferred semantic pass.
    save_manifest(inc["files"], root=str(ROOT), kind="ast")

    # 8. Refresh the HTML view (best-effort; never fatal).
    try:
        subprocess.run(
            [sys.executable, "-m", "graphify", "export", "html"],
            cwd=str(ROOT), check=False, capture_output=True,
        )
    except Exception:
        pass

    _log(
        f"Synced: {len(changed_code)} code changed, {len(deleted)} deleted "
        f"-> {G.number_of_nodes()} nodes, {G.number_of_edges()} edges."
    )
    if changed_docs:
        _log(
            f"WARNING: {len(changed_docs)} doc(s) changed and are pending semantic "
            f"re-embed. Run /graphify-sync to embed them (spends tokens)."
        )
        return 10
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        _log(f"ERROR: {exc}")
        sys.exit(1)
