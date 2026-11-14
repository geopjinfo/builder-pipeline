'use strict';
/*
 * The neutral persona and skill format, read once for every adapter. Pure: text in, values out, no fs.
 *
 * A persona (`agents/*.md`) opens with a frontmatter block of `key: value` lines: name, description, capabilities
 * (one value or a comma list), tier (strong | mid | low), effort (optional), writes (optional: the ONE file a
 * read-only seat may write). A `#` starts a comment on every line, the description included, exactly as the
 * Claude Code transform has always read it, so every adapter sees the same values.
 */

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const WRITE_CAPS = new Set(['code', 'test-only', 'docs']);

/** { fm, body, get } or null when the text has no frontmatter. `body` starts right after the closing `---`. */
function split(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('---', 4);
  if (end === -1) return null;
  const fm = content.slice(4, end);
  const get = (k) => ((fm.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1] || '').split('#')[0].trim();
  return { fm, body: content.slice(end + 3), get };
}

/**
 * What a seat may do, in harness-neutral terms:
 *   'read-only' inspect only · 'own-file' read-only plus the one `writes:` file · 'write' edits (`cap` says which
 *   kind: code, test-only, docs) · 'publish' read and publish a page, never a repo write.
 * Anything not recognised is read-only: a typo in `capabilities` never gains write access. This is the same
 * decision the Claude Code transform makes; that adapter keeps its literal code so its output stays byte-identical.
 */
function accessOf(capabilities, writes) {
  const caps = (capabilities || 'read-only').split(',').map((c) => c.trim()).filter(Boolean);
  if (caps.includes('publish')) return { access: 'publish', cap: 'publish', caps };
  if (caps.length === 1 && WRITE_CAPS.has(caps[0])) return { access: 'write', cap: caps[0], caps };
  if (caps.length === 1 && caps[0] === 'read-only+own-file' && writes) return { access: 'own-file', cap: 'read-only', caps };
  if (writes && caps.includes('read-only')) return { access: 'own-file', cap: 'read-only', caps };
  return { access: 'read-only', cap: 'read-only', caps };
}

/** A persona as plain values, or null when it has no frontmatter. */
function parsePersona(content) {
  const s = split(content);
  if (!s) return null;
  const writes = s.get('writes');
  const effort = s.get('effort');
  return {
    name: s.get('name'),
    description: s.get('description'),
    tier: s.get('tier') || 'strong',
    effort: EFFORTS.has(effort) ? effort : '',
    writes,
    ...accessOf(s.get('capabilities'), writes),
    body: s.body,
  };
}

/**
 * The tool-limits paragraph a harness without per-seat (or per-path) enforcement puts at the top of the seat's
 * instructions. `harness` is the name the paragraph uses for it.
 */
function limitsText({ access, cap, writes }, harness) {
  const check = `${harness} does not hold this per seat, so the orchestrator checks \`git status --porcelain\` after the phase and reverts anything outside it.`;
  if (access === 'write') {
    const what = {
      code: 'you may edit the code and tests your brief names',
      'test-only': 'you may edit test files only; never production code',
      docs: 'you may edit only the doc paths your brief allows',
    }[cap];
    return `Tool limits for this seat (${cap}): ${what}. ${check}`;
  }
  if (access === 'own-file') {
    return `Tool limits for this seat (read-only): make no file edits and run inspection commands only, except the ONE file you may write: \`${writes}\`. ${check}`;
  }
  if (access === 'publish') {
    return `Tool limits for this seat (read-only): make no file edits and run inspection commands only. The page-publishing tool this seat uses elsewhere does not exist here, so report what you would publish instead. ${check}`;
  }
  return `Tool limits for this seat (read-only): make no file edits (no patches, no shell writes) and run inspection commands only. ${check}`;
}

/**
 * A kit skill as an Agent Skills `SKILL.md` (`name` + `description` frontmatter). Kit skills already carry both;
 * one without a `name:` line gets it from the folder name, which is what both readers fall back to anyway.
 */
function agentSkill(name, content) {
  const s = split(content);
  if (!s) return `---\nname: ${name}\ndescription: ${name}\n---\n\n${content}`;
  if (s.get('name')) return content;
  return `---\nname: ${name}\n${content.slice(4)}`;
}

/** A persona body for a harness that re-renders it: LF line endings (a CRLF checkout renders the same), no leading blank lines. */
const bodyText = (body) => body.replace(/\r\n/g, '\n').replace(/^\n+/, '');

module.exports = { EFFORTS, split, accessOf, parsePersona, limitsText, agentSkill, bodyText };
