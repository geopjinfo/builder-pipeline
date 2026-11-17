'use strict';
/**
 * The runner that owns a headless worker's clocks (plan M6, REQ-602, REQ-603, D12).
 *
 * WHY. Codex has no turn cap or timeout flag, and a Claude Code flag is a request the harness may not honour. So the
 * runner, not the worker, enforces the pass timeout (the whole job) and the stall window (silence on the event
 * stream). A worker that never exits is FAILED-TIMEOUT and is stopped; one that stops emitting is FAILED-STALL. The
 * adapter's `keySourceVerdict` is asked after every event until it answers; a fault stops the worker before any model
 * call (STOPPED-KEY-SOURCE).
 *
 *   runWorker({ bin, args, env, cwd, prompt, passTimeoutMs, stallTimeoutMs, keySourceVerdict, onLine })
 *     → { outcome: EXITED | FAILED-TIMEOUT | FAILED-STALL | STOPPED-KEY-SOURCE, exitCode, signal, events, lines,
 *         stderr, keyFault, stopped, startError }
 *
 * `bin` is an absolute path; a `.js`/`.cjs`/`.mjs` bin runs under this Node (the test stubs). The prompt goes to
 * stdin, which is then closed. Stdout is read line by line; every JSON line is an event, other lines are kept as text.
 */
const { spawn } = require('child_process');
const readline = require('readline');

const OUTCOME = Object.freeze({ exited: 'EXITED', timeout: 'FAILED-TIMEOUT', stall: 'FAILED-STALL', key: 'STOPPED-KEY-SOURCE' });
const KILL_GRACE_MS = 2000;

function runWorker({ bin, args, env, cwd, prompt = '', passTimeoutMs, stallTimeoutMs, keySourceVerdict = null, onLine = null, onSpawn = null }) {
  if (!(Number.isFinite(passTimeoutMs) && passTimeoutMs > 0)) throw new Error('worker-runner: passTimeoutMs must be a number > 0 (REQ-603)');
  if (!(Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0)) throw new Error('worker-runner: stallTimeoutMs must be a number > 0 (REQ-603)');
  const [cmd, argv] = /\.(c|m)?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  return new Promise((resolve) => {
    const events = [];
    const lines = [];
    let stderr = '';
    let outcome = null;
    let keyFault = null;
    let keyState = null;
    let stopped = false;
    let startError = null;
    let killTimer = null;
    const child = spawn(cmd, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // REQ-1516: the loop runner samples the worker's RSS by pid; the hook never throws into the runner
    if (onSpawn) {
      try {
        onSpawn(child);
      } catch (_) {
        /* a sampler fault never stops a worker */
      }
    }

    const stop = (why) => {
      if (outcome === null) outcome = why;
      if (stopped) return;
      stopped = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          /* already gone */
        }
      }, KILL_GRACE_MS);
    };
    const passTimer = setTimeout(() => stop(OUTCOME.timeout), passTimeoutMs);
    let stallTimer = setTimeout(() => stop(OUTCOME.stall), stallTimeoutMs);
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stop(OUTCOME.stall), stallTimeoutMs);
    };

    child.on('error', (e) => {
      startError = e.message;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      armStall();
      lines.push(line);
      if (onLine) onLine(line);
      let ev = null;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (ev === null || typeof ev !== 'object') return;
      events.push(ev);
      if (keyState === null && keySourceVerdict) {
        keyState = keySourceVerdict(events);
        if (keyState && keyState !== 'ok') {
          keyFault = keyState;
          stop(OUTCOME.key);
        }
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(passTimer);
      clearTimeout(stallTimer);
      if (killTimer) clearTimeout(killTimer);
      if (keyState === null && keySourceVerdict && outcome === null) {
        const late = keySourceVerdict(events);
        if (late && late !== 'ok') keyFault = late;
        else if (!late && events.length === 0 && !startError) keyFault = 'stream ended before its first event — no key source seen';
        if (keyFault) outcome = OUTCOME.key;
      }
      resolve({ outcome: outcome || OUTCOME.exited, exitCode: code, signal, events, lines, stderr, keyFault, stopped, startError });
    });
  });
}

module.exports = { OUTCOME, KILL_GRACE_MS, runWorker };
