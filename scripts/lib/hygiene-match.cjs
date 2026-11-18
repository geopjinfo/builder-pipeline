'use strict';
/**
 * Glob matching for the hygiene checks (specs/repo-hygiene.spec.md, M21). One rule set, shared by the gate checks:
 *
 *   `*`  any run of characters except `/`        `**`  any run of characters, `/` included
 *   `?`  one character except `/`                 a trailing `/` names a folder: the glob matches every path under it
 *   a glob without `/` matches any one path segment (like a .gitignore line); a glob with `/` matches from the root
 *
 * A branch name is matched as a path (`claude/*` matches `claude/task-1`). Nothing here reads the file system.
 */

function globToRegExp(glob) {
  let g = String(glob).replace(/^\.\//, '');
  const folder = g.endsWith('/');
  if (folder) g = g.slice(0, -1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const anchored = g.includes('/');
  const head = anchored ? '^' : '(^|/)';
  const tail = folder ? '(/.*)?$' : '($|/)';
  return new RegExp(head + re + tail);
}

/** True when `path` (posix, relative) matches any glob of `globs`. A path under a matched folder matches too. */
function matchesAny(path, globs) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return (globs || []).some((g) => globToRegExp(g).test(p));
}

/** The globs of `globs` that match `path`, for a report that names the rule. */
function matching(path, globs) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return (globs || []).filter((g) => globToRegExp(g).test(p));
}

module.exports = { globToRegExp, matchesAny, matching };
