#!/usr/bin/env python3
"""One entry for every index-refresh trigger: merge hook, session start, pipeline P1/P4, by hand.

Code and docs refresh on the SAME triggers, with no watcher. Code sync is free (parsing, no model)
and always runs. Doc embedding spends tokens, so it runs automatically only while the pending docs
total at most the limit; above it a person decides, because an unattended trigger that embeds an
unbounded backlog is an unbudgeted spend.

Sequence: take the lock -> free code sync (sync.main) -> pending docs and their bytes -> a decision
-> optional embed -> status file -> release the lock.

Usage:
  autosync.py --trigger merge|session|p1|p4|manual [--no-embed] [--hold-lock SECONDS]

  --no-embed        code sync only (a pre-audit gate uses this: free, seconds)
  --hold-lock N     test aid: take the lock, hold it N seconds, touch nothing else
  --release-on P    test aid (with --hold-lock): release as soon as path P exists

Environment:
  INDEX_AUTO_LIMIT_KB          auto-embed limit in KB (default 300); above it a person decides
  INDEX_EMBED_COMMAND          shell command that embeds the pending docs. Unset -> decision
                               "no-embedder". The pack assumes no particular model CLI. The command
                               runs from the repo root with INDEX_PENDING_FILE, INDEX_OUT_DIR and
                               INDEX_SYNC_SKIP=1 set; it must rewrite the pending file to what is
                               still unembedded (sync.write_pending, which deletes it when empty).
  INDEX_SYNC_SKIP              set -> exit 0 at once. The embed command inherits it, so an embed
                               (e.g. a headless agent session) can never re-trigger this script.
  INDEX_STALE_LOCK_SECONDS     a lock older than this belongs to a dead holder (default 7200)
  INDEX_ROOT, INDEX_OUT_DIR    see sync.py

Decisions: none (nothing pending) · not-requested (--no-embed) · over-limit · no-embedder · embed

Exit codes: 0 fresh · 10 docs still pending (over the limit, no embedder, not requested, or the
embed left some) · 20 another trigger holds the lock · 3 no index · 1 error.

Writes, all inside the index directory: .sync.lock (while running), .sync.log (appended; hook-
launched runs have no terminal) and .autosync-status.json (the last run's decision, which the
session hook reads to decide whether to speak).
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync  # noqa: E402

LOCK = sync.OUT / ".sync.lock"
STATUS = sync.OUT / ".autosync-status.json"
LOG = sync.OUT / ".sync.log"
DEFAULT_LIMIT_KB = 300
# An embed within the limit takes minutes; two hours without release means the holder died.
DEFAULT_STALE_LOCK_SECONDS = 7200
EXIT_FRESH, EXIT_ERROR, EXIT_ABSENT, EXIT_PENDING, EXIT_LOCKED = 0, 1, 3, 10, 20


def _env_number(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
        return value if value > 0 else default
    except ValueError:
        return default


class _Tee:
    """Everything printed also lands in the index directory's .sync.log."""

    def __init__(self, stream, path: Path):
        self._stream, self._file = stream, open(path, "a", encoding="utf-8")

    def write(self, text):
        try:
            self._stream.write(text)
        except Exception:
            pass
        self._file.write(text)
        self._file.flush()

    def flush(self):
        try:
            self._stream.flush()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Pure, importable pieces.
# ---------------------------------------------------------------------------

def acquire_lock(path: Path, now: float, stale_after: float = DEFAULT_STALE_LOCK_SECONDS, pid: int = None) -> bool:
    """Exclusive create holding { pid, started }. A lock older than `stale_after` belongs to a dead
    holder and is taken over ONCE; a second failure means a live trigger won the race."""
    pid = os.getpid() if pid is None else pid
    for _ in range(2):
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                started = float(json.loads(path.read_text(encoding="utf-8")).get("started", 0))
            except Exception:
                # Unreadable: maybe a holder mid-write. Treat it as fresh unless the file itself is old.
                try:
                    started = path.stat().st_mtime
                except OSError:
                    continue
            if now - started > stale_after:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                continue
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"pid": pid, "started": now}, handle)
        return True
    return False


def release_lock(path: Path, pid: int = None) -> bool:
    """Remove the lock only if it is ours: a reclaimed lock now belongs to someone else."""
    pid = os.getpid() if pid is None else pid
    try:
        if json.loads(path.read_text(encoding="utf-8")).get("pid") == pid:
            path.unlink()
            return True
    except Exception:
        pass
    return False


def decide_embed(pending_bytes: int, limit_bytes: int, embedder: bool, allowed: bool = True) -> str:
    """The order matters: nothing pending beats everything; a --no-embed run never reports a spend
    it was not asked to make; the limit is judged before the embedder so an over-limit backlog says
    "a person decides" even on a machine that could embed it."""
    if pending_bytes <= 0:
        return "none"
    if not allowed:
        return "not-requested"
    if pending_bytes > limit_bytes:
        return "over-limit"
    if not embedder:
        return "no-embedder"
    return "embed"


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _pending_now():
    pending = sync.load_pending()
    return pending, sum(doc["bytes"] for doc in sync.pending_facts(pending))


# ---------------------------------------------------------------------------

def main(argv: list, code_sync=None) -> int:
    """`code_sync` is injectable so the decision and embed path can be tested without graphify."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--trigger", required=True, choices=["merge", "session", "p1", "p4", "manual"])
    parser.add_argument("--no-embed", action="store_true")
    parser.add_argument("--hold-lock", type=float, default=0)
    parser.add_argument("--release-on", default=None)
    args = parser.parse_args(argv)

    if os.environ.get("INDEX_SYNC_SKIP"):
        return EXIT_FRESH
    if not sync.OUT.is_dir():
        print(f"[autosync] no index directory at {sync.OUT}: build the index once first.", flush=True)
        return EXIT_ABSENT

    sys.stdout = _Tee(sys.stdout, LOG)  # type: ignore[assignment]
    sys.stderr = _Tee(sys.stderr, LOG)  # type: ignore[assignment]
    prefix = f"[autosync {_stamp()} {args.trigger} pid={os.getpid()}]"
    limit_bytes = int(_env_number("INDEX_AUTO_LIMIT_KB", DEFAULT_LIMIT_KB) * 1024)
    stale_after = _env_number("INDEX_STALE_LOCK_SECONDS", DEFAULT_STALE_LOCK_SECONDS)

    if not acquire_lock(LOCK, time.time(), stale_after):
        # Two concurrent embeds double the spend and can corrupt the index: the loser does nothing.
        print(f"{prefix} lock held by another trigger; exiting without work.", flush=True)
        return EXIT_LOCKED
    try:
        if args.hold_lock:
            # --release-on PATH: hold until PATH exists (at most --hold-lock seconds), so a test releases the lock
            # on a signal instead of racing a timer it cannot see under load.
            print(f"{prefix} holding the lock {args.hold_lock:g}s (test aid).", flush=True)
            deadline = time.time() + args.hold_lock
            while time.time() < deadline:
                if args.release_on and os.path.exists(args.release_on):
                    break
                time.sleep(min(0.05, max(0.0, deadline - time.time())))
            return EXIT_FRESH

        code = (code_sync or sync.main)()
        if code in (EXIT_ERROR, EXIT_ABSENT):
            return code
        os.chdir(sync.ROOT)  # pending paths are root-relative

        pending, pending_bytes = _pending_now()
        embed_command = os.environ.get("INDEX_EMBED_COMMAND", "").strip()
        decision = decide_embed(pending_bytes, limit_bytes, bool(embed_command), not args.no_embed)
        print(
            f"{prefix} code sync exit {code}; {len(pending)} doc(s) pending, {pending_bytes // 1024} KB "
            f"(limit {limit_bytes // 1024} KB); decision: {decision}.",
            flush=True,
        )

        embed_rc = None
        if decision == "embed":
            env = {**os.environ, "INDEX_SYNC_SKIP": "1", "INDEX_PENDING_FILE": str(sync.PENDING), "INDEX_OUT_DIR": str(sync.OUT)}
            try:
                embed_rc = subprocess.run(embed_command, shell=True, cwd=str(sync.ROOT), env=env).returncode
            except Exception as exc:
                print(f"{prefix} embed command failed to start: {exc}", flush=True)
                embed_rc = -1
            pending, pending_bytes = _pending_now()
            print(f"{prefix} embed exit {embed_rc}; {len(pending)} doc(s) still pending.", flush=True)

        STATUS.write_text(json.dumps({
            "at": _stamp(), "trigger": args.trigger, "codeSyncExit": code, "decision": decision,
            "embedExit": embed_rc, "pendingDocs": len(pending), "pendingBytes": pending_bytes,
            "limitBytes": limit_bytes,
        }, indent=2), encoding="utf-8")
        return EXIT_PENDING if pending else EXIT_FRESH
    finally:
        release_lock(LOCK)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[autosync] ERROR: {exc}", flush=True)
        sys.exit(EXIT_ERROR)
