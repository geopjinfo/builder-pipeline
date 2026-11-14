'use strict';
/*
 * The harness adapters, one module each, all pure (inputs in, { path, content } out). cli.js does the writing.
 *
 * Every adapter exports: id, pointer, agentsDir, renderAgent(neutralMd, { models?, file? }), skillPath(name),
 * renderSkill(name, content), unconfirmed (string[]). Hook wiring differs by harness: claude-code exports
 * hooksSettings() (a block a person merges), codex and antigravity export hooksConfig() (a file, or null).
 *
 * Codex and Antigravity read skills from the SAME folder, `.agents/skills/<name>/SKILL.md`, and render the same
 * content there. The caller de-duplicates: skillFiles() returns each path once, with every tool that wants it,
 * and throws if two tools would write different content to one path (which would mean one silently wins).
 */

const adapters = {
  'claude-code': require('./claude-code.cjs'),
  codex: require('./codex.cjs'),
  antigravity: require('./antigravity.cjs'),
};

/**
 * skillFiles(selected, skills) → [{ path, content, tools }].
 * `selected`: adapter ids (unknown ids are ignored, so a caller can pass its whole --tool list).
 * `skills`: [{ name, content }] — the kit skills to install.
 */
function skillFiles(selected, skills) {
  const byPath = new Map();
  for (const id of selected) {
    const a = adapters[id];
    if (!a) continue;
    for (const { name, content } of skills) {
      const f = a.renderSkill(name, content);
      const seen = byPath.get(f.path);
      if (!seen) byPath.set(f.path, { path: f.path, content: f.content, tools: [id] });
      else if (seen.content !== f.content) throw new Error(`skill ${name}: ${seen.tools.join(', ')} and ${id} render different content to ${f.path}`);
      else if (!seen.tools.includes(id)) seen.tools.push(id);
    }
  }
  return [...byPath.values()];
}

module.exports = { ...adapters, adapters, skillFiles };
