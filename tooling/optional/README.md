# Optional modules — port only if the target wants them

## caveman-context.js (token-saver output mode)
SessionStart hook that puts every session in compressed "caveman" prose (~75% output-token cut;
code/CLI/API names/error strings stay verbatim; safety warnings drop to normal prose).
**Two-part install:** (1) this hook wired in `.claude/settings.json` under `SessionStart`;
(2) the `caveman` SKILL itself, which lives at USER level (`~/.claude/skills/caveman/`) — copy it
from the source machine or drop it repo-level under `.claude/skills/`. Without the skill the hook's
instruction has nothing to point at. Env opt-out and level knob are inside the hook file.

## sync.py + sync-hook.sh (knowledge-graph auto-sync)
Keeps a graphify knowledge graph current: free AST re-sync on every merge to the base branch(es)
via a guarded post-merge block, deferred token-spending doc embeds tracked in a visible pending
file. **Requires the graphify tool installed** (`graphify-out/.graphify_python` written by a full
run) — without it these are inert. Localize: the branch list in sync-hook.sh's guard (YOUR base
branch, not just main — that exact mistake cost the source repo 20 days of silent rot), and add a
`.graphifyignore` excluding human-facing publishes and derived artifacts (index what must be
FOUND; grep serves what is already ADDRESSED).

Both ship as-is from the source repo; neither is wired by UNPACK — deliberate, they are choices.
