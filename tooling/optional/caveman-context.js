#!/usr/bin/env node
/**
 * SessionStart caveman-mode injector (token saver). Optional; Claude Code only.
 *
 * Registered in .claude/settings.json for SessionStart. Caveman is a
 * session-scoped output style (.claude/skills/caveman/SKILL.md — vendor it in the repo,
 * from the kit's skills-extra/caveman/, so a fresh clone or a new account carries it;
 * a user-level ~/.claude/skills/caveman copy is then not required) that
 * compresses prose ~65-75% while keeping every technical detail exact.
 * Because it resets each session, this hook re-asserts it automatically so
 * nobody has to type /caveman. Prints the instruction as SessionStart
 * additionalContext on stdout; exit 0 = inject.
 *
 * Default intensity: full. Override per-session with /caveman lite|full|ultra,
 * or turn off with "stop caveman". Change CAVEMAN_LEVEL below to move the
 * team default. Set NO_CAVEMAN=1 to opt this session out entirely.
 */
'use strict';

if (process.env.NO_CAVEMAN) process.exit(0);

const CAVEMAN_LEVEL = 'full'; // team default: lite | full | ultra

const context = [
  `Caveman mode ACTIVE for this repo (intensity: ${CAVEMAN_LEVEL}).`,
  'Compress every prose response per the caveman skill (.claude/skills/caveman/SKILL.md, in this repo):',
  'drop articles, filler, pleasantries, hedging; fragments OK; short synonyms.',
  'Keep VERBATIM, never compress: code blocks, commit/PR text, CLI commands,',
  'API/function/symbol names, exact error strings.',
  'Auto-clarity override — drop to normal prose for security warnings, irreversible-action',
  'confirmations, and multi-step sequences where terseness risks a misread; resume after.',
  'Persist across every response until the user says "stop caveman" / "normal mode".',
].join(' ');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }) + '\n',
);
process.exit(0);
