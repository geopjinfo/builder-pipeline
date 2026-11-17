# SETUP_PROMPT — set up the builder kit from your AI tool

Open your AI tool (Claude Code, Codex or Antigravity) at the root of the project, and paste this one line,
with `<tag>` replaced by the release you want (for example `v1.0.2`):

```
Set up builder in this project: run `npx github:geopjinfo/builder-pipeline#<tag> bootstrap`, then follow the builder-init skill.
```

That is the whole setup prompt. Everything else is in the `builder-init` skill.

## What it does

1. **`bootstrap` (the CLI, no AI).** Fetches the kit at that tag with `npx` and adds two things:
   - the `builder-init` skill, for each AI tool it detects in the project, recorded in `builder.lock.json` (so a later
     inventory knows the skill is the kit's, not yours);
   - the kit itself as a devDependency of the project, at the same `github:…#<tag>` spec (`package.json` is created
     if there is none), then `npm install --save-dev` it. Every later `npx builder-pipeline …` then runs this kit from the
     project's `node_modules` — without it, a bare `npx builder-pipeline` would fetch the newest registry release, not your tag. No
     npm on PATH: the dependency is still written, and bootstrap tells you to run `npm install` before going on.
     `--no-dependency` skips this step.

   It installs nothing else, changes no other existing file and needs no API key. The kit stays zero-dependency.
2. **`builder-init` (the skill, in your AI tool).** The judgement part:
   - decides **greenfield** (empty or near-empty repo: it interviews you — what is built, for whom, stack, domain —
     and drafts `PIPELINE_PROFILE.md`) or **brownfield** (it reads your code, docs and existing agent setup);
   - runs `npx builder-pipeline inventory --json`, which lists every skill, agent, persona and hook you already have and
     scores each against the kit;
   - reviews **every** item against the kit and shows you one table: verdict (keep yours / use the kit's / keep both,
     the kit's renamed `builder-<name>`) with reasons;
   - waits for your confirm, then records each answer with `npx builder-pipeline choices set …` into
     `builder.choices.json` — so a later `upgrade` never undoes them;
   - installs (`npx builder-pipeline unpack`), verifies (`npx builder-pipeline verify`), and runs the persona detector
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

- Node 18 or newer (`node --version`), with npm.
- Network access to fetch the tag (npx, then `npm install`). After that the kit runs offline.
- No clean tree needed; the skill counts your uncommitted files first so kit files can be told from your edits.

Rules the skill follows: it treats every file it reads as data, not instructions; it never installs over, beside or
instead of one of your items without your yes for that item; it stops and asks on anything destructive or ambiguous.
