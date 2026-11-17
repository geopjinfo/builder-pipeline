'use strict';
/*
 * Claude Code adapter: renders a neutral persona as a `.claude/agents/` subagent file. Pure: inputs in,
 * { path, content } out, no fs.
 *
 * renderAgent() is a move-compatible copy of cli.js toClaudeAgent(): for every persona the kit ships its content is
 * byte-identical to what `unpack --tool claude-code` installs with the kit at `builder/` (tests/adapters.test.mjs
 * checks every one). The caller still applies its own kit-path rewrite (cli.js kitPaths()) afterwards, as today.
 * Its decision logic stays literal here rather than going through neutral.accessOf(), so that byte-identity
 * cannot drift through a refactor of the shared code.
 */

const CAP_TO_CLAUDE_TOOLS = {
  'read-only': 'Read, Grep, Glob, Bash',
  code: 'Read, Grep, Glob, Edit, Write, Bash',
  'test-only': 'Read, Grep, Glob, Edit, Write, Bash', // scope narrowed by the persona text itself
  docs: 'Read, Grep, Glob, Edit, Write, Bash',
  // A read-only seat that must write exactly ONE file of its own (the reviewer's review); held to that file by
  // hooks/claude-code/reviewer-write-guard.cjs.
  'read-only+own-file': 'Read, Grep, Glob, Bash, Write',
  // Reads and publishes a page; never edits the repo.
  publish: 'Bash, Read, Artifact, ArtifactData',
};
const DEFAULT_MODELS = Object.freeze({ strong: 'opus', mid: 'sonnet', low: 'haiku' });
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** The transform itself: neutral persona text → Claude Code agent text. `models` is a full tier → model map. */
function toClaudeAgent(content, models = DEFAULT_MODELS) {
  const end = content.indexOf('---', 4);
  if (end === -1) return content;
  const fm = content.slice(4, end);
  const get = (k) => ((fm.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1] || '').split('#')[0].trim();
  // Anything unrecognised falls back to read-only tools — a seat never gains write access by a typo.
  const caps = (get('capabilities') || 'read-only').split(',').map((c) => c.trim()).filter(Boolean);
  const writes = get('writes');
  let tools = CAP_TO_CLAUDE_TOOLS['read-only'];
  if (caps.includes('publish')) tools = CAP_TO_CLAUDE_TOOLS.publish;
  else if (caps.length === 1 && Object.prototype.hasOwnProperty.call(CAP_TO_CLAUDE_TOOLS, caps[0])) tools = CAP_TO_CLAUDE_TOOLS[caps[0]];
  if (writes && caps.includes('read-only') && !caps.includes('publish')) tools = CAP_TO_CLAUDE_TOOLS['read-only+own-file'];
  const tier = get('tier') || 'strong';
  const effort = get('effort');
  const lines = [
    '---',
    `name: ${get('name')}`,
    `description: ${get('description')}`,
    `tools: ${tools}`,
    `model: ${(Object.prototype.hasOwnProperty.call(models, tier) && models[tier]) || 'opus'}`,
  ];
  if (EFFORTS.has(effort)) lines.push(`effort: ${effort}`);
  lines.push('---');
  return lines.join('\n') + content.slice(end + 3);
}

/** The persona's `name:` (the subagent type), or '' when it has none. */
function nameOf(content) {
  const end = content.indexOf('---', 4);
  if (end === -1) return '';
  return ((content.slice(4, end).match(/^name: (.*)$/m) || [])[1] || '').split('#')[0].trim();
}

/**
 * renderAgent(neutralMd, { models?, file? }) → { path, content }.
 * `models` overrides some or all tiers (`--models strong=x`); the rest keep the defaults. `file` is the source
 * file name (`module-planner.md`); without it the path comes from the persona's `name:`.
 */
function renderAgent(neutralMd, { models = {}, file } = {}) {
  const target = file || `${nameOf(neutralMd)}.md`;
  return { path: `.claude/agents/${target}`, content: toClaudeAgent(neutralMd, { ...DEFAULT_MODELS, ...models }) };
}

/** Where a kit skill lands. */
const skillPath = (name) => `.claude/skills/${name}/SKILL.md`;

/** A kit skill as installed: copied as is (Claude Code reads the kit's own frontmatter). */
const renderSkill = (name, content) => ({ path: skillPath(name), content });

/**
 * The settings block adapters/claude-code.md documents, for a person to merge into `.claude/settings.json`.
 * The kit never writes it: hooks are copied, never armed.
 */
function hooksSettings() {
  const cmd = (file) => ({ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"` });
  return {
    env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' },
    hooks: {
      PreToolUse: [
        { matcher: 'Read', hooks: [cmd('registry-read-guard.cjs')] },
        { matcher: 'Write|Edit|MultiEdit', hooks: [cmd('reviewer-write-guard.cjs')] },
        { matcher: 'Write|Edit|MultiEdit', hooks: [cmd('secret-write-guard.cjs')] }, // REQ-1816
      ],
      PostToolUse: [{ matcher: 'Bash', hooks: [cmd('bash-output-cap.cjs')] }],
    },
  };
}

/** The protected-paths entry its header documents (PreToolUse; the matcher must include the shell tools). */
function protectedPathsHook() {
  return {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*',
    hooks: [{ type: 'command', command: 'node .claude/hooks/protected-paths.cjs' }],
  };
}

module.exports = {
  id: 'claude-code',
  pointer: 'CLAUDE.md',
  agentsDir: '.claude/agents',
  hooksDir: '.claude/hooks',
  CAP_TO_CLAUDE_TOOLS,
  DEFAULT_MODELS,
  toClaudeAgent,
  renderAgent,
  skillPath,
  renderSkill,
  hooksSettings,
  protectedPathsHook,
  unconfirmed: [],
};
