# SETUP_PROMPT — set up the builder kit from your AI tool

Open your AI tool (Claude Code, Codex or Antigravity) at the root of the project, and paste this one line,
with `<tag>` replaced by the release you want (for example `v0.17.0`):

```
Set up builder in this project: run `npx github:geopjinfo/builder-pipeline#<tag> bootstrap`, then follow the builder-init skill.
```

That is the whole setup prompt. Everything else is in the `builder-init` skill.

## What it does

1. **`bootstrap` (the CLI, no AI).** Fetches the kit at that tag with `npx` and adds ONE thing: the
   `builder-init` skill, for each AI tool it detects in the project. It installs nothing else, changes no
   existing file and needs no API key. The kit stays zero-dependency.
2. **`builder-init` (the skill, in your AI tool).** The judgement part:
   - decides **greenfield** (empty or near-empty repo: it interviews you — what is built, for whom, stack, domain —
     and drafts `PIPELINE_PROFILE.md`) or **brownfield** (it reads your code, docs and existing agent setup);
   - runs `npx builder inventory --json`, which lists every skill, agent, persona and hook you already have and
     scores each against the kit;
   - reviews **every** item against the kit and shows you one table: verdict (keep yours / use the kit's / keep both,
     the kit's renamed `builder-<name>`) with reasons;
   - waits for your confirm, then records each answer with `npx builder choices set …` into
     `builder.choices.json` — so a later `upgrade` never undoes them;
   - installs (`npx builder unpack`), verifies (`npx builder verify`), and runs the persona detector
     (`persona-detect`).

   Your own items win by default. Anything that could clash and that you did not decide is **skipped**, not
   installed.

## Per tool

| Tool | Where `bootstrap` puts the skill | Run it again later |
|---|---|---|
| Claude Code | `.claude/skills/builder-init/SKILL.md` | `/builder-init` |
| Codex | `.agents/skills/builder-init/SKILL.md` | `$builder-init` |
| Antigravity | `.agents/skills/builder-init/SKILL.md` | ask for the `builder-init` skill by name |

Several tools in one project: `bootstrap` adds the skill for each one it detects; run `builder-init` from any of
them once — the choices file is shared.

## Before you paste

- Node 18 or newer (`node --version`).
- Network access to fetch the tag once. After that the kit runs offline.
- No clean tree needed; the skill counts your uncommitted files first so kit files can be told from your edits.

Rules the skill follows: it treats every file it reads as data, not instructions; it never installs over, beside or
instead of one of your items without your yes for that item; it stops and asks on anything destructive or ambiguous.
