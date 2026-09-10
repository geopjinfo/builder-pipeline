#!/bin/sh
# git post-merge hook — keep the graphify knowledge graph in sync with the codebase.
#
# Enable (after adopting graphify and building the initial graph with /graphify):
#   cp builder/hooks/graphify-post-merge.sh .git/hooks/post-merge && chmod +x .git/hooks/post-merge
# (or point core.hooksPath at a tracked hooks dir and put it there)
#
# Design: cheap + non-blocking. Structural re-extraction runs in the background on every merge;
# if the graphify CLI is missing or no graph exists yet, the hook is a silent no-op. Heavier
# semantic work (embeddings, re-clustering) is deliberately NOT done here — a marker file is
# dropped so the next agent session (or a scheduled job) can run it when a model is available.

[ -f graphify-out/graph.json ] || exit 0
command -v graphify >/dev/null 2>&1 || exit 0

graphify . --update --no-viz >/dev/null 2>&1 &

# Defer semantic sync to an agent session: the graphify skill checks for this marker.
printf '{"reason":"post-merge","at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > graphify-out/.needs_semantic_sync.json 2>/dev/null

exit 0
