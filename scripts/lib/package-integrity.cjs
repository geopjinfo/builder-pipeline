'use strict';
/**
 * What the installed package's scripts are SUPPOSED to be — anchored outside node_modules.
 *
 * WHY. Installed with npm, the hooks run kit scripts from `node_modules/@geopjinfo/builder-pipeline/`, which is not
 * in the project's repository and is writable by any agent in the session. A hash taken FROM node_modules vouches for
 * whatever is on disk at the time, tampered or not. The anchor has to be something a person committed that an agent
 * cannot satisfy by writing files: the `integrity` npm wrote into the project's package-lock.json (the sha512 of the
 * published tarball). This reads that tarball from npm's content-addressed cache, checks it against the integrity,
 * and takes each script's hash from the TARBALL. node_modules is then compared to it: any file that differs, and the
 * package is recorded as unverified (no file hashes), so nothing is ever vouched for on node_modules' word.
 *
 * Fails closed: no package-lock entry, no integrity (e.g. a git dependency), no cached tarball, a tarball that does
 * not match, or a node_modules file that differs → { verified: false, reason }. The hooks then do not run package code.
 *
 * Zero dependencies: zlib (built in) + a small ustar/pax reader.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const NAME = '@geopjinfo/builder-pipeline';
/** The files a hook can load or spawn — everything under scripts/ that Node can run. */
const RECORDED = /^scripts\/.*\.(c?js|mjs)$/;

/** sha256 of the text with CRLF read as LF (the installer's lock hash). */
const textSha = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');

/** The package-lock.json entry for the kit, or null. */
function lockEntry(projectRoot, name = NAME) {
  try {
    const pl = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    return pl.packages?.[`node_modules/${name}`] || pl.dependencies?.[name] || null;
  } catch {
    return null;
  }
}

/** npm's cache folder: npm_config_cache, else npm's default for this platform. */
function cacheDir(env = process.env) {
  if (env.npm_config_cache) return env.npm_config_cache;
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache');
  return path.join(os.homedir(), '.npm');
}

/** The cached tarball for an `sha512-<base64>` integrity (cacache content-v2 layout), or null. */
function cachedTarball(integrity, env = process.env) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity || '').split(/\s+/).find((s) => s.startsWith('sha512-')) || '');
  if (!m) return null;
  const hex = Buffer.from(m[1], 'base64').toString('hex');
  const file = path.join(cacheDir(env), '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return crypto.createHash('sha512').update(bytes).digest('base64') === m[1] ? bytes : null;
}

/** Regular files of a (gunzipped) tar, as { path: Buffer }. ustar prefix and pax `path=` records are honoured. */
function untar(buf) {
  const out = {};
  let pax = null;
  for (let at = 0; at + 512 <= buf.length; ) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {};
      for (const rec of body.toString('utf8').split('\n')) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(rec);
        if (m) pax[m[1]] = m[2];
      }
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(345, 500);
    const name = pax?.path || (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    pax = null;
    if (type === '0' || type === '\0' || type === '7') out[name] = Buffer.from(body);
  }
  return out;
}

/**
 * The lock's `package` record: { name, version, integrity, verified, files | reason }.
 *   projectRoot  where package-lock.json is
 *   kitDir       the installed package folder (node_modules/@geopjinfo/builder-pipeline)
 */
function packageRecord(projectRoot, kitDir, { env = process.env } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(kitDir, 'package.json'), 'utf8')).version;
  const base = { name: NAME, version };
  const entry = lockEntry(projectRoot);
  if (!entry) return { ...base, verified: false, reason: `no ${NAME} entry in package-lock.json` };
  if (!entry.integrity) return { ...base, verified: false, reason: 'package-lock.json records no integrity for the package (a git dependency?)' };
  const tgz = cachedTarball(entry.integrity, env);
  if (!tgz) return { ...base, integrity: entry.integrity, verified: false, reason: 'the tarball for that integrity is not in the npm cache, or its bytes do not match it (run npm ci, then upgrade)' };
  let entries;
  try {
    entries = untar(zlib.gunzipSync(tgz));
  } catch (e) {
    return { ...base, integrity: entry.integrity, verified: false, reason: `the cached tarball does not unpack: ${e.message}` };
  }
  const files = {};
  for (const [name, bytes] of Object.entries(entries)) {
    const rel = name.replace(/^[^/]+\//, ''); // npm tarballs hold one top folder (package/)
    if (!RECORDED.test(rel)) continue;
    const sha = textSha(bytes);
    const onDisk = path.join(kitDir, ...rel.split('/'));
    if (!fs.existsSync(onDisk) || textSha(fs.readFileSync(onDisk)) !== sha) {
      return { ...base, integrity: entry.integrity, verified: false, reason: `node_modules differs from the published tarball: ${rel}` };
    }
    files[rel] = sha;
  }
  if (!Object.keys(files).length) return { ...base, integrity: entry.integrity, verified: false, reason: 'the tarball holds no scripts' };
  return { ...base, integrity: entry.integrity, verified: true, files: Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]])) };
}

module.exports = { NAME, textSha, lockEntry, cacheDir, cachedTarball, untar, packageRecord };
