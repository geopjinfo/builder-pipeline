'use strict';
/**
 * The one door every model-backed check sends through — `features.outboundGuard`.
 *
 * WHY THIS EXISTS. The experiments in EXPERIMENTS.md §12–15 hand a diff, an excerpt or a list of search hits to a
 * cheap model. Development already sends code to the session's own model; what must never leave is a key, a
 * password, a connection string or a whole secrets file. A guard each experiment writes for itself is a guard one of
 * them forgets. So there is one: it refuses a payload that names a denied file, carries a secret-shaped string or a
 * value from the project's env files, or is larger than an excerpt should be. It never redacts and sends anyway — a
 * redaction that misses one character still leaks, so a match means NOT SENT, and the step goes on without advice.
 *
 * FAILS OPEN FOR THE PIPELINE, CLOSED FOR THE DATA. A refused payload, a failed call and a timed-out call all come
 * back as "no advice" — the step continues as if the experiment were off. Nothing here ever blocks a phase.
 *
 * Reasons name the file and the kind of match, never the matched text, so a refusal can be logged safely.
 *
 * Pure over text and an injected `fsLike`; `defaultFs` is the only filesystem access.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Secret shapes. Each is specific enough that a hit is worth refusing the payload over. THE ONE LIST (D88, REQ-1817):
 * the outbound guard, the secret scan, the pre-commit hook and the write guard all import `SHAPES` from here. A copy
 * elsewhere fails tests/secret-scan.test.mjs.
 */
const PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  // A gateway's own key (OmniRoute / Bifrost style: a short prefix, an underscore, a long random tail) or a long bearer
  // token in a header — conservative: the tail must be 32+ random-looking characters, so a placeholder or a word passes.
  ['gateway token', /\b(?:omr|bfr|bf|or|gw|vk)_[A-Za-z0-9]{32,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{40,}(?![A-Za-z0-9._~+/=-])/],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i],
  ['assigned secret', /(?<![a-z0-9])(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[a-z0-9_]*["']?\s*[:=]\s*["']?(?![<{$]|\*{3}|x{3})([^\s"',;]{8,})/i],
];

/** An assigned value that is a reference in code (`process.env.X`, `config.db.pass`), not a literal. */
const REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+\)?$/;

const DEFAULTS = {
  maxBytes: 8000,
  denyPaths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '*.keystore', 'credentials*.json'],
  envFiles: ['.env', '.env.local', '.env.development', '.env.test'],
  extraPatterns: [],
  timeoutMs: 20000,
};

const defaultFs = { read: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) };

/** `*` matches inside one path segment; the pattern is tested against the file's base name. */
function globToRegex(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');
}

/** Values from KEY=VALUE lines in the env files that are long enough to be a real secret (not `true`, not a port). */
function knownSecrets(root, envFiles = DEFAULTS.envFiles, fsLike = defaultFs) {
  const values = new Set();
  for (const rel of envFiles) {
    const text = fsLike.read(path.join(root, rel));
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value.length >= 8 && !/^(?:true|false|null|localhost|changeme|<.*>|\$\{.*\})$/i.test(value)) values.add(value);
    }
  }
  return [...values];
}

/**
 * @param {string} text
 * @param {{ secrets?: string[], extraPatterns?: string[] }} [opts]
 * @returns {Array<{ kind: string, line: number }>}  never the matched text
 */
function scan(text, { secrets = [], extraPatterns = [] } = {}) {
  const patterns = [...PATTERNS, ...extraPatterns.map((p, i) => [`project pattern ${i + 1}`, new RegExp(p)])];
  const hits = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const [kind, re] of patterns) {
        const m = re.exec(line);
        if (m && !(kind === 'assigned secret' && REFERENCE.test(m[1]))) hits.push({ kind, line: i + 1 });
      }
      if (secrets.some((s) => line.includes(s))) hits.push({ kind: 'value from an env file', line: i + 1 });
    });
  return hits;
}

/**
 * Decide whether a payload may leave.
 * @param {{ text?: string, files?: Array<{ path: string, content?: string }> }} payload
 * @param {{ root?: string, config?: object, fsLike?: typeof defaultFs }} [opts]
 * @returns {{ send: boolean, reasons: string[], bytes: number }}
 */
function check(payload, { root = process.cwd(), config = {}, fsLike = defaultFs } = {}) {
  const c = { ...DEFAULTS, ...config };
  const deny = c.denyPaths.map(globToRegex);
  const secrets = knownSecrets(root, c.envFiles, fsLike);
  const reasons = [];
  const parts = [{ label: 'text', content: payload?.text ?? '' }];
  for (const f of payload?.files ?? []) {
    const base = path.basename(String(f.path).replace(/\\/g, '/'));
    if (deny.some((re) => re.test(base))) reasons.push(`${f.path}: denied file`);
    parts.push({ label: f.path, content: f.content ?? '' });
  }
  let bytes = 0;
  for (const p of parts) {
    bytes += Buffer.byteLength(p.content, 'utf8');
    for (const hit of scan(p.content, { secrets, extraPatterns: c.extraPatterns })) reasons.push(`${p.label}:${hit.line}: ${hit.kind}`);
  }
  if (bytes > c.maxBytes) reasons.push(`payload is ${bytes} bytes, over the ${c.maxBytes}-byte excerpt limit — send paths and excerpts, not files`);
  return { send: reasons.length === 0, reasons, bytes };
}

/**
 * Send through the guard. `call(payload)` is the experiment's own model call.
 * @returns {Promise<{ sent: false, reasons: string[] } | { sent: true, ok: true, result: any } | { sent: true, ok: false, error: string }>}
 */
async function send(payload, call, opts = {}) {
  const verdict = check(payload, opts);
  if (!verdict.send) return { sent: false, reasons: verdict.reasons };
  const timeoutMs = opts.config?.timeoutMs ?? DEFAULTS.timeoutMs;
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => call(payload)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { sent: true, ok: true, result };
  } catch (e) {
    return { sent: true, ok: false, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

const SHAPES = PATTERNS;

module.exports = { SHAPES, PATTERNS, DEFAULTS, scan, knownSecrets, check, send, globToRegex };
