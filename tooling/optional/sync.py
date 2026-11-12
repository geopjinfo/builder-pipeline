#!/usr/bin/env python3
"""graphify sync worker: incremental, token-free graph regeneration. The pack's EXAMPLE index tool.

Invoked by autosync.py (the one entry for the merge hook, session start and the pipeline's P1/P4
gates) and by hand. Re-extracts ONLY changed code files by parsing (zero model tokens), merges them
into the existing graph, and preserves the human-written community labels. Changed docs are recorded
for a deferred embedding pass and are never sent to a model here.

Usage:
  sync.py            sync code; record changed docs as pending
  sync.py --check    write NOTHING; print ONE JSON facts line in the index exit-code contract shape

Layout: expects to live two directories below the repo root (e.g. scripts/graphify/sync.py).
  INDEX_ROOT       overrides the repo root (default: two levels above this file)
  INDEX_OUT_DIR    overrides the index directory (default: <root>/graphify-out)

Exit codes (sync mode):
  0  synced, and nothing is pending
  10 synced, but docs are pending embedding, INCLUDING docs recorded by an EARLIER run.
     Why: in one adopting project a sync printed "Nothing changed" and exited 0 over more than a
     hundred pending docs, and every caller read that exit as "fresh".
  3  no graph.json yet: run a full graphify build first
  1  error

Exit codes (--check), mirroring the facts line so a caller that reads only the exit is not misled:
  0 fresh · 3 absent · 4 unmeasurable (graph present, graphify not importable) ·
  10 docs pending · 11 code behind · 12 both
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

# Resolve the repo root from this file's location, so the worker is correct regardless of the cwd a
# git hook or a session hook runs it in. The env overrides exist for relocation and for tests.
ROOT = Path(os.environ["INDEX_ROOT"]).resolve() if os.environ.get("INDEX_ROOT") else Path(__file__).resolve().parents[2]
OUT = Path(os.environ["INDEX_OUT_DIR"]).resolve() if os.environ.get("INDEX_OUT_DIR") else ROOT / "graphify-out"
GRAPH = OUT / "graph.json"
LABELS = OUT / ".graphify_labels.json"
PENDING = OUT / ".needs_semantic_sync.json"
MANIFEST = OUT / "manifest.json"
UNSORTED_LABEL = "Unsorted (pending recluster)"

# Extensions graphify extracts structurally (by parsing): everything else is a "doc" and needs
# semantic extraction, which is deferred.
CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java",
    ".cpp", ".c", ".cc", ".cxx", ".hpp", ".h", ".rb", ".swift", ".kt", ".kts",
    ".cs", ".scala", ".php", ".lua",
}


def _log(msg: str) -> None:
    print("[graphify-sync] " + msg, flush=True)


# ---------------------------------------------------------------------------
# Pending-doc list. Pure helpers take their inputs, so a test needs no graph.
# ---------------------------------------------------------------------------

def load_pending(path: Path = None) -> list:
    path = PENDING if path is None else path
    if not path.exists():
        return []
    try:
        return list(json.loads(path.read_text(encoding="utf-8")).get("files", []))
    except Exception:
        return []


def write_pending(files: list, path: Path = None) -> None:
    """An EMPTY list deletes the flag file: an empty flag file still reads as "pending" to a caller
    that only tests for the file's existence."""
    path = PENDING if path is None else path
    unique = sorted(set(files))
    if not unique:
        if path.exists():
            path.unlink()
        return
    path.write_text(json.dumps({"files": unique}, ensure_ascii=False, indent=2), encoding="utf-8")


def ignore_predicate(root: Path = None):
    """`path -> bool` using graphify's own ignore-file semantics (last match wins, parent rule).

    The matcher is graphify-internal; when this graphify version does not expose it, nothing is
    treated as ignored (pending docs are then only pruned when they no longer exist on disk).
    """
    root = ROOT if root is None else root
    try:
        from graphify.detect import _is_ignored, _load_graphifyignore
    except Exception:
        return lambda _p: False

    patterns = _load_graphifyignore(root)
    cache: dict = {}
    resolved_root = root.resolve()

    def is_ignored(p: str) -> bool:
        candidate = Path(p)
        if not candidate.is_absolute():
            candidate = resolved_root / candidate
        return _is_ignored(candidate.resolve(), resolved_root, patterns, _cache=cache)

    return is_ignored


def prune_pending(files: list, is_ignored, exists=os.path.exists) -> tuple:
    """Split pending docs into (kept, pruned). Pruned = ignored now, or no longer on disk.

    Why: paths added to the ignore file AFTER they were recorded as pending otherwise sit in the queue,
    and in the byte count every auto-embed limit is judged by, indefinitely.
    """
    kept, pruned = [], []
    for f in sorted(set(files)):
        (pruned if (not exists(f) or is_ignored(f)) else kept).append(f)
    return kept, pruned


def pending_facts(files: list) -> list:
    out = []
    for f in files:
        try:
            out.append({"path": f, "bytes": os.path.getsize(f)})
        except OSError:
            continue
    return out


def prune_manifest(is_ignored, path: Path = None, root: Path = None) -> int:
    """Drop manifest entries for ignored files, so an ignore rule added later takes effect structurally
    instead of by a hand edit of the manifest."""
    path = MANIFEST if path is None else path
    root = ROOT if root is None else root
    if not path.exists():
        return 0
    manifest = json.loads(path.read_text(encoding="utf-8"))
    keep = {}
    for key, entry in manifest.items():
        absolute = Path(key) if Path(key).is_absolute() else root / key
        if not is_ignored(str(absolute)):
            keep[key] = entry
    removed = len(manifest) - len(keep)
    if removed:
        path.write_text(json.dumps(keep, indent=2), encoding="utf-8")
    return removed


def head_commit():
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(ROOT), capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Output writer, shareable with an embed step so both preserve labels the same way.
# ---------------------------------------------------------------------------

def old_communities() -> tuple:
    old = json.loads(GRAPH.read_text(encoding="utf-8"))
    old_comm = {n["id"]: n.get("community") for n in old.get("nodes", [])}
    labels: dict = {}
    if LABELS.exists():
        try:
            labels = {int(k): v for k, v in json.loads(LABELS.read_text(encoding="utf-8")).items()}
        except Exception:
            labels = {}
    return old_comm, labels


def write_outputs(G, old_comm: dict, labels: dict, detection: dict) -> None:
    """Rebuild the community map preserving labels, then write graph.json, the report and labels.

    New nodes inherit the community of their most common already-labelled neighbour; orphans land in
    an "Unsorted (pending recluster)" bucket, reused across runs rather than minted fresh each time.
    """
    from graphify.analyze import god_nodes, suggest_questions, surprising_connections
    from graphify.cluster import score_all
    from graphify.export import to_json
    from graphify.report import generate

    known_cids = [c for c in old_comm.values() if isinstance(c, int)]
    unsorted_cid = next((cid for cid, label in labels.items() if label == UNSORTED_LABEL), None)
    if unsorted_cid is None:
        unsorted_cid = (max(known_cids + list(labels)) + 1) if (known_cids or labels) else 0

    node_comm: dict = {}
    for n in G.nodes():
        c = old_comm.get(n)
        if isinstance(c, int):
            node_comm[n] = c
    for n in G.nodes():
        if n in node_comm:
            continue
        neigh = Counter(node_comm[m] for m in G.neighbors(n) if m in node_comm)
        node_comm[n] = neigh.most_common(1)[0][0] if neigh else unsorted_cid

    communities: dict = {}
    for n, c in node_comm.items():
        communities.setdefault(c, []).append(n)
    if unsorted_cid in communities and unsorted_cid not in labels:
        labels[unsorted_cid] = UNSORTED_LABEL

    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)
    try:
        # The commit stamp is information only: freshness is measured by content.
        to_json(G, communities, str(GRAPH), force=True, built_at_commit=head_commit(), community_labels=labels)
    except TypeError:  # a graphify version without the stamp parameter
        to_json(G, communities, str(GRAPH), force=True, community_labels=labels)
    report = generate(
        G, communities, cohesion, labels, gods, surprises, detection, {"input": 0, "output": 0},
        str(ROOT), suggested_questions=questions,
    )
    (OUT / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    LABELS.write_text(json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False), encoding="utf-8")


def export_html() -> None:
    # -P (3.11+): `-m` must not put the current folder, i.e. the repository, first on sys.path, or a planted
    # graphify.py there would run instead of the installed tool.
    flags = ["-P"] if sys.version_info >= (3, 11) else []
    try:
        subprocess.run([sys.executable, *flags, "-m", "graphify", "export", "html"], cwd=str(ROOT), check=False, capture_output=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------

def check() -> int:
    """Facts only, no writes. One JSON line on stdout; the verdict is scripts/lib/index-check.cjs's."""
    if not GRAPH.exists():
        print(json.dumps({"index": False}))
        return 3
    os.chdir(ROOT)
    try:
        from graphify.detect import detect_incremental
    except Exception:
        print(json.dumps({"index": True, "tooling": False}))
        return 4

    is_ignored = ignore_predicate(ROOT)
    inc = detect_incremental(ROOT, kind="ast")
    changed = [f for lst in (inc.get("new_files", {}) or {}).values() for f in lst]
    changed_code = [f for f in changed if Path(f).suffix.lower() in CODE_EXTS]
    changed_docs = [f for f in changed if Path(f).suffix.lower() not in CODE_EXTS]
    deleted = len(inc.get("deleted_files", []) or [])
    kept, pruned = prune_pending(load_pending() + changed_docs, is_ignored)
    try:
        built = json.loads(GRAPH.read_text(encoding="utf-8")).get("built_at_commit")
    except Exception:
        built = None
    facts = {
        "index": True,
        "tooling": True,
        "changedCode": len(changed_code),
        "deleted": deleted,
        "pendingDocs": pending_facts(kept),
        "pruned": len(pruned),
    }
    if built:
        facts["builtAtCommit"] = built
    head = head_commit()
    if head:
        facts["head"] = head
    print(json.dumps(facts, ensure_ascii=False))
    code_behind = (len(changed_code) + deleted) > 0
    docs_pending = len(facts["pendingDocs"]) > 0
    return 12 if (code_behind and docs_pending) else 11 if code_behind else 10 if docs_pending else 0


def main() -> int:
    if not GRAPH.exists():
        _log("No graph.json yet: run a full graphify build before enabling auto-sync.")
        return 3
    os.chdir(ROOT)

    try:
        from graphify.build import build_merge
        from graphify.detect import detect_incremental, save_manifest
        from graphify.extract import collect_files, extract
    except Exception as exc:  # graphify not importable: never block the merge or the session
        _log(f"graphify not importable ({exc}). Skipping.")
        return 1

    is_ignored = ignore_predicate(ROOT)
    pruned_manifest = prune_manifest(is_ignored)
    if pruned_manifest:
        _log(f"Pruned {pruned_manifest} manifest entr{'y' if pruned_manifest == 1 else 'ies'} for ignored files.")

    # 1. What changed since the last graph state? (content-hash based)
    inc = detect_incremental(ROOT, kind="ast")
    new_files = inc.get("new_files", {}) or {}
    deleted = list(inc.get("deleted_files", []) or [])
    changed = [f for lst in new_files.values() for f in lst]

    changed_code = [f for f in changed if Path(f).suffix.lower() in CODE_EXTS]
    changed_docs = [f for f in changed if Path(f).suffix.lower() not in CODE_EXTS]

    # Pending = earlier runs' backlog + this run's changed docs, minus what is ignored or gone.
    kept, pruned = prune_pending(load_pending() + changed_docs, is_ignored)
    write_pending(kept)
    if pruned:
        _log(f"Dropped {len(pruned)} pending doc(s) that are ignored or gone.")

    if not changed and not deleted:
        _log("Nothing changed since the last sync.")
        if kept:
            _log(f"{len(kept)} doc(s) still pending embedding from an earlier run.")
            return 10
        return 0

    # 2. Parse-extract only the changed code files (zero tokens).
    code_paths: list = []
    for f in changed_code:
        p = Path(f)
        code_paths.extend(collect_files(p) if p.is_dir() else [p])
    ast = extract(code_paths, cache_root=ROOT) if code_paths else {
        "nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0,
    }

    # 3. Capture the old community/label mapping BEFORE the merge.
    old_comm, labels = old_communities()

    # 4. Merge changed code into the existing graph; prune deleted files. Docs are NOT in `ast`, so
    #    their existing nodes are preserved untouched until the deferred embedding pass runs.
    G = build_merge([ast], graph_path=str(GRAPH), prune_sources=deleted or None, root=str(ROOT), directed=False)

    # 5-6. Communities (labels preserved), graph.json, report.
    write_outputs(G, old_comm, labels, {
        "total_files": inc.get("total_files", 0),
        "total_words": inc.get("total_words", 0),
        "files": inc.get("files", {}),
    })

    # 7. Save the manifest so the NEXT run diffs against this state. kind="ast" stamps the parse hash
    #    and clears the semantic hash for changed docs, keeping them flagged for the deferred pass.
    save_manifest(inc["files"], root=str(ROOT), kind="ast")

    # 8. Refresh the HTML view (best-effort; never fatal).
    export_html()

    _log(
        f"Synced: {len(changed_code)} code changed, {len(deleted)} deleted "
        f"-> {G.number_of_nodes()} nodes, {G.number_of_edges()} edges."
    )
    if kept:
        _log(f"WARNING: {len(kept)} doc(s) pending embedding (spends tokens). See autosync.py.")
        return 10
    return 0


if __name__ == "__main__":
    try:
        sys.exit(check() if "--check" in sys.argv[1:] else main())
    except Exception as exc:
        _log(f"ERROR: {exc}")
        sys.exit(1)
