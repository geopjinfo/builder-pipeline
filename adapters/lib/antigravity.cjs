'use strict';
/*
 * Google Antigravity adapter. Pure: inputs in, { path, content } out, no fs.
 *
 * Checked against the official docs on 2026-11-14:
 *   Discovery       https://antigravity.google/docs/customization-discovery/
 *     Workspace `.agents/`: rules `rules/*.md`, `AGENTS.md`, `GEMINI.md` · skills `skills/<name>/SKILL.md` · custom
 *     agents `agents/<name>.md` (or `agents/<name>/agent.md`) · hooks `hooks.json` · MCP `mcp_config.json`.
 *     `AGENTS.md` and `GEMINI.md` are read in the workspace folder and each parent up to the repo root.
 *     Workflows are deprecated in favour of skills. `.agent/` (singular) is the legacy spelling.
 *   Custom agents   https://antigravity.google/docs/subagents/
 *     Markdown with YAML frontmatter; the body is the system prompt. `name`, `description` (required); `tools`
 *     (string list, default []); `mainAgent`, `subagent` (booleans, default true); `model` (`inherit` | `flash` |
 *     `pro`, default inherit); `commandExecutionPolicy` (`off` | `auto` | `eager` | `sandbox`, default sandbox);
 *     `mcpServers`, `skills`, `plugins`. Tool names used here are the ones the docs spell: view_file, list_dir,
 *     find_by_name, grep_search, run_command, write_to_file, replace_file_content, multi_replace_file_content
 *     (the last four also from https://antigravity.google/docs/hooks/). A misspelt tool name can hang the agent.
 *   Skills          https://antigravity.google/docs/skills/
 *     `<workspace-root>/.agents/skills/<folder>/SKILL.md`; `description` required, `name` optional (folder name).
 *   Hooks           https://antigravity.google/docs/hooks/
 *     `.agents/hooks.json`; events SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop. The
 *     input is `toolCall { name, args }` plus `workspacePaths`, and a PreToolUse hook answers with a JSON `decision`
 *     on stdout; exit codes are not documented. The kit's hooks read `tool_name` / `tool_input` and block with exit
 *     2, so none of them runs here unchanged: this adapter writes no hooks.json (see `unconfirmed`).
 *
 * The plan's assumptions, settled: `.agents/agents/*.md` personas CONFIRMED · `.agents/skills` CONFIRMED (same path
 * as Codex, written once) · `.agents/hooks.json` location CONFIRMED but not emitted · pointer AGENTS.md CONFIRMED
 * (GEMINI.md is read too; no order between the two is documented, so the kit writes AGENTS.md only).
 */

const { parsePersona, limitsText, agentSkill, bodyText } = require('./neutral.cjs');

const READ_TOOLS = ['view_file', 'list_dir', 'find_by_name', 'grep_search', 'run_command'];
const EDIT_TOOLS = ['write_to_file', 'replace_file_content', 'multi_replace_file_content'];
const TOOLS_BY_ACCESS = {
  'read-only': READ_TOOLS,
  // The one review file: creating a file is enough. Nothing holds the seat to that ONE path here (no hook runs);
  // the instructions name it and the post-phase check catches the rest.
  'own-file': [...READ_TOOLS, 'write_to_file'],
  write: [...READ_TOOLS, ...EDIT_TOOLS],
  // The publishing tool is a Claude Code one; here the seat is read-only.
  publish: READ_TOOLS,
};
const MODELS = new Set(['inherit', 'flash', 'pro']);
const DEFAULT_MODELS = Object.freeze({ strong: 'pro', mid: 'flash', low: 'flash' });

/** A YAML scalar that is always a string: a JSON string is a valid YAML double-quoted scalar. */
const yamlString = (v) => JSON.stringify(String(v));

/**
 * renderAgent(neutralMd, { models?, file? }) → { path, content, access }.
 * `models` overrides tiers with one of the documented values (inherit | flash | pro); an unknown value writes
 * `inherit`. Neutral `effort` has no documented field and is dropped.
 */
function renderAgent(neutralMd, { models = {}, file } = {}) {
  const p = parsePersona(neutralMd);
  if (!p || !p.name) throw new Error(`antigravity: ${file || 'persona'} has no frontmatter name`);
  const map = { ...DEFAULT_MODELS, ...models };
  const model = Object.prototype.hasOwnProperty.call(map, p.tier) && MODELS.has(map[p.tier]) ? map[p.tier] : 'inherit';
  const tools = TOOLS_BY_ACCESS[p.access] || READ_TOOLS;
  const lines = [
    '---',
    `name: ${yamlString(p.name)}`,
    `description: ${yamlString(p.description)}`,
    'tools:',
    ...tools.map((t) => `  - ${t}`),
    'mainAgent: false',
    'subagent: true',
    `model: ${model}`,
    '---',
    '',
    limitsText(p, 'Antigravity'),
    '',
  ];
  return { path: `.agents/agents/${p.name}.md`, content: lines.join('\n') + bodyText(p.body), access: p.access };
}

/** Where a kit skill lands. The same path as Codex's: the caller writes it once (index.cjs skillFiles()). */
const skillPath = (name) => `.agents/skills/${name}/SKILL.md`;

const renderSkill = (name, content) => ({ path: skillPath(name), content: agentSkill(name, content) });

/** No hooks file: the kit has no hook in Antigravity's input/output shape yet. */
const hooksConfig = () => null;

/** Left out on purpose, each for a stated reason. */
const unconfirmed = [
  'hooks (.agents/hooks.json): location documented, but the input (toolCall {name, args}) and the JSON decision output differ from the kit hooks (tool_name/tool_input, exit 2) and exit codes are undocumented; nothing emitted until a shim exists',
  'per-path write limits (test-only, docs, the reviewer\'s one file): `tools` grants whole tools, not paths; held by the instructions and the post-phase git status check',
  'effort: no documented per-agent effort field; dropped',
  'tools: [] semantics undocumented; every agent gets an explicit list',
  'workflows: deprecated in favour of skills; none emitted',
  'GEMINI.md vs AGENTS.md precedence undocumented; pointer goes in AGENTS.md only',
];

module.exports = {
  id: 'antigravity',
  pointer: 'AGENTS.md',
  agentsDir: '.agents/agents',
  hooksDir: null,
  TOOLS_BY_ACCESS,
  DEFAULT_MODELS,
  renderAgent,
  skillPath,
  renderSkill,
  hooksConfig,
  unconfirmed,
};
