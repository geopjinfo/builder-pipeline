/**
 * Batch orchestrator — the credit lane (scripts/lib/orch-credit.cjs + orch-worker-claude-code.cjs). Every run uses
 * the STUB worker (tests/fixtures/orch/stub-worker.cjs) replaying synthetic stream fixtures — no model, no key.
 * Every guard has a red case.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FIX, STUB, git, orch, profileText, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const credit = require('../scripts/lib/orch-credit.cjs');

const STREAMS = join(FIX, 'streams');
const CREDIT = (over = {}) => ({ enabled: true, dailyCapUsd: 60, fallback: [], ...over });

/** A repo with the credit lane on, a clean home, and the stub worker wired. */
function rig({ fallback = false, files = {} } = {}) {
  const orchestrator = fallback
    ? { credit: CREDIT({ fallback: ['secondary', 'primary'] }), secondaryConfigDir: '.claude-secondary' }
    : { credit: CREDIT() };
  const { dir, repo } = scratchRepo({ profile: profileText({ orchestrator }), files });
  const home = join(dir, 'home');
  mkdirSync(home);
  const brief = join(dir, 'brief.md');
  writeFileSync(brief, 'Fix row 1 of the k1 board.\n');
  return { dir, repo, home, brief, root: join(dir, 'orch'), creditDir: join(dir, 'credit'), echo: join(dir, 'echo.json'), mark: join(dir, 'model-called'), log: join(dir, 'starts.jsonl') };
}

function envFor(r, fixture, extra = {}) {
  return {
    BUILDER_ORCH_CREDIT_DIR: r.creditDir,
    USERPROFILE: r.home,
    HOME: r.home,
    BUILDER_CREDIT_WORKER_BIN: STUB,
    BUILDER_STUB_FIXTURE: join(STREAMS, fixture),
    BUILDER_STUB_ECHO: r.echo,
    BUILDER_STUB_MARK: r.mark,
    BUILDER_STUB_LOG: r.log,
    ANTHROPIC_API_KEY: 'stub-not-a-key', // a test value: neither the stub nor the runner reads it
    ANTHROPIC_AUTH_TOKEN: 'stub-not-a-token',
    CLAUDE_CODE_ENTRYPOINT: 'cli', // must NOT reach the worker
    ...extra,
  };
}
const cli = (r, fixture, args, extra) => orch(r.repo, r.root, args, envFor(r, fixture, extra));

function prepAndRun(r, fixture, { tail, kind = 'record-fixes', scope = 'tasks/k1.md', model = 'mid-model', extra = {} } = {}) {
  const prep = cli(r, fixture, ['credit-prep', 'c1', 't1', '--key', 'k1', '--kind', kind, '--scope', scope, '--worktree', r.repo, '--brief', r.brief, '--model', model, '--budget', '0.5'], extra);
  assert.equal(prep.status, 0, prep.out);
  const run = cli(r, fixture, ['credit-run', 'c1', 't1'], { ...(tail ? { BUILDER_STUB_TAIL: JSON.stringify(tail) } : {}), ...extra });
  const dir = join(r.creditDir, 'runs', 'c1', 't1');
  const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
  const starts = existsSync(r.log) ? readFileSync(r.log, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)) : [];
  return { prep, run, dir, verdict: read(join(dir, 'verdict.json')), echo: read(r.echo), starts };
}

describe('a credit job: prompt file → headless worker → verdict in the records', () => {
  const r = rig();
  const { prep, run, dir, verdict, echo } = prepAndRun(r, 'complete.jsonl');

  test('the prompt is written under the credit dir and the run command printed', () => {
    assert.match(prep.stdout, /node scripts\/orch\.mjs credit-run c1 t1/);
    assert.match(readFileSync(join(dir, 'prompt.md'), 'utf8'), /^You are a credit-lane worker \(kind: record-fixes\) for task t1 of run c1; record key k1\./);
    assert.match(readFileSync(join(dir, 'prompt.md'), 'utf8'), /Never write DONE, closed, verified/);
  });

  test('the worker starts headless with the prompt on stdin, in the guard config dir, without the parent\'s session variables', () => {
    assert.deepEqual(echo.argv.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
    assert.ok(!echo.argv.includes('--bare'));
    assert.match(echo.stdinFirstLine, /^You are a credit-lane worker/);
    assert.match(echo.configDir, /\.claude-credit-worker$/);
    assert.equal(echo.envNames.includes('CLAUDE_CODE_ENTRYPOINT'), false);
  });

  test('COMPLETE (exit 0); with no pipeline run for the key the verdict goes to .pipeline/<key>/credit-lane.md', () => {
    assert.equal(run.status, 0, run.out);
    assert.equal(verdict.status, 'COMPLETE');
    assert.equal(verdict.resultLine, 'RESULT: PASS row 1 checked (tasks/k1.md:3)');
    assert.deepEqual(verdict.changed, []);
    assert.equal(verdict.review, 'NOT-NEEDED');
    assert.equal(existsSync(join(r.repo, '.pipeline', 'k1', 'state.md')), false); // never create a run state
    assert.match(readFileSync(join(r.repo, '.pipeline', 'k1', 'credit-lane.md'), 'utf8'), /## credit-lane c1\/t1 — .* — COMPLETE[\s\S]*cost \$0\.0075/);
  });

  test('red: a key whose pipeline run owns state.md gets the verdict appended there, and no credit-lane.md', () => {
    const r2 = rig();
    mkdirSync(join(r2.repo, '.pipeline', 'k1'), { recursive: true });
    writeFileSync(join(r2.repo, '.pipeline', 'k1', 'state.md'), '# k1 state\n');
    assert.equal(prepAndRun(r2, 'complete.jsonl').run.status, 0);
    const text = readFileSync(join(r2.repo, '.pipeline', 'k1', 'state.md'), 'utf8');
    assert.ok(text.startsWith('# k1 state\n'));
    assert.match(text, /## credit-lane c1\/t1 — .* — COMPLETE/);
    assert.equal(existsSync(join(r2.repo, '.pipeline', 'k1', 'credit-lane.md')), false);
  });
});

describe('the key source is checked before any model call', () => {
  test('red: a login (non-key) start is stopped (exit 10) and no model call happens', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'oauth.jsonl');
    assert.equal(run.status, 10, run.out);
    assert.equal(verdict.status, 'REFUSED-KEY-SOURCE');
    assert.match(verdict.keyFault, /apiKeySource is "none", not ANTHROPIC_API_KEY/);
    assert.equal(existsSync(r.mark), false);
    assert.equal(verdict.costUsd, 0);
  });

  test('red: a model event before the start event is stopped the same way', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'model-first.jsonl');
    assert.equal(run.status, 10, run.out);
    assert.match(verdict.keyFault, /first non-hook stream event is assistant/);
    assert.equal(existsSync(r.mark), false);
  });

  test('red: a guard config dir holding user memory is refused before the worker starts', () => {
    const r = rig();
    mkdirSync(join(r.home, '.claude-credit-worker'), { recursive: true });
    writeFileSync(join(r.home, '.claude-credit-worker', 'CLAUDE.md'), 'memory\n');
    const prep = cli(r, 'complete.jsonl', ['credit-prep', 'c1', 't1', '--key', 'k1', '--kind', 'docs', '--scope', 'README.md', '--worktree', r.repo, '--brief', r.brief, '--model', 'mid-model']);
    assert.equal(prep.status, 0, prep.out);
    const run = cli(r, 'complete.jsonl', ['credit-run', 'c1', 't1']);
    assert.equal(run.status, 3);
    assert.match(run.out, /guard config dir is not clean — .*CLAUDE\.md exists/);
    assert.equal(existsSync(r.echo), false);
  });
});

describe('denials, scope and integrity', () => {
  test('red: a denied command → INCOMPLETE (exit 8) naming it once; a plain failing command is not a denial', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'denied.jsonl');
    assert.equal(run.status, 8, run.out);
    assert.equal(verdict.status, 'INCOMPLETE');
    assert.deepEqual(verdict.denied, ['Bash: npm ls']);
  });

  test('red: a worker that edits a protected path, a file outside scope and a lockfile fails (exit 9), each named', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'out-of-scope.jsonl');
    assert.equal(run.status, 9, run.out);
    assert.equal(verdict.status, 'FAILED-SCOPE');
    const faults = verdict.scope.join('\n');
    assert.match(faults, /src\/platform\/kernel\/x\.ts: forbidden path \(src\/platform\/\*\*\)/);
    assert.match(faults, /notes\/outside\.md: outside the task scope/);
    assert.match(faults, /package-lock\.json: forbidden path/);
    assert.doesNotMatch(faults, /tasks\/k1\.md/);
  });

  test('red: a gitignored harness config file touched during the run is seen and forbidden', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'complete.jsonl', { tail: [{ _stub: 'write', path: '.claude/settings.local.json', text: '{}' }] });
    assert.equal(run.status, 9, run.out);
    assert.match(verdict.scope.join('\n'), /\.claude\/settings\.local\.json: forbidden path \(\.claude\/\*\*\)/);
  });

  test('red: forbidden wins even when the scope is everything', () => {
    const forbidden = credit.forbiddenGlobs(credit.creditContext({ protected: ['src/platform/**'] }));
    const faults = credit.scopeFaults(['src/platform/a.ts', '.git/config', 'node_modules/x/index.js', 'docs/a.md'], ['**'], forbidden);
    assert.equal(faults.length, 3);
    assert.doesNotMatch(faults.join('\n'), /docs\/a\.md/);
  });

  test('red: a worker that appends a git hook fails FAILED-INTEGRITY (exit 13)', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'hook-tamper.jsonl');
    assert.equal(run.status, 13, run.out);
    assert.equal(verdict.status, 'FAILED-INTEGRITY');
    assert.match(verdict.integrity.join('\n'), /common:hooks\/pre-commit: added/);
  });

  test('red: a dirty worktree is refused — every change a job leaves must be its own', () => {
    const r = rig();
    const prep = cli(r, 'complete.jsonl', ['credit-prep', 'c1', 't1', '--key', 'k1', '--kind', 'docs', '--scope', 'README.md', '--worktree', r.repo, '--brief', r.brief, '--model', 'mid-model']);
    assert.equal(prep.status, 0);
    writeFileSync(join(r.repo, 'a.txt'), 'dirty\n');
    const run = cli(r, 'complete.jsonl', ['credit-run', 'c1', 't1']);
    assert.equal(run.status, 3);
    assert.match(run.out, /is dirty/);
  });
});

describe('failure classification and the RESULT line', () => {
  test('red: a billing failure stops the credit (billingStop), status FAILED (exit 1)', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'billing.jsonl');
    assert.equal(run.status, 1, run.out);
    assert.deepEqual([verdict.status, verdict.failure, verdict.billingStop], ['FAILED', 'billing', true]);
  });

  test('red: an unknown API error is NOT billing; a 429 is a rate limit, never billing', () => {
    const r = rig();
    assert.deepEqual([prepAndRun(r, 'other-error.jsonl').verdict.failure, prepAndRun(rig(), 'rate-limit.jsonl').verdict.billingStop], ['other', false]);
    assert.equal(credit.classifyFailure('FAILED', { errorTexts: ['API Error: 429 rate_limit_error, see your billing page'] }), 'rate-limit');
    assert.equal(credit.classifyFailure('COMPLETE', {}), null);
  });

  test('red: a successful run without RESULT: PASS is FAILED with failure "result" — a job fault, never a fallback', () => {
    const r = rig();
    const { run, verdict } = prepAndRun(r, 'no-pass.jsonl');
    assert.equal(run.status, 1, run.out);
    assert.deepEqual([verdict.status, verdict.failure], ['FAILED', 'result']);
    assert.equal(credit.isJobFault(verdict), true);
    assert.equal(credit.isJobFault({ status: 'FAILED', failure: 'billing' }), false);
  });
});

describe('kinds, the model floor and the allow list', () => {
  const ctx = credit.creditContext({ models: { strong: 'strong-model', mid: 'mid-model' } });
  const base = { key: 'k1', task: 't1', worktree: tmp('wt'), budgetUsd: 1, scope: ['tasks/k1.md'] };

  test('red: building, planning, reviewing and orchestrating seats stay on a plan account', () => {
    for (const kind of credit.MAX_SEATS) assert.throws(() => credit.validateTask({ ...base, kind, model: 'strong-model' }, ctx), /stays on a plan account/);
    assert.throws(() => credit.validateTask({ ...base, kind: 'deploy', model: 'mid-model' }, ctx), /unknown credit kind/);
  });

  test('red: a strong seat refuses the mid model; a mid floor refuses a cheaper model; code-reading runs on anything', () => {
    for (const kind of ['standards-auditor', 'security-auditor', 'invariant-auditor']) {
      assert.throws(() => credit.validateTask({ ...base, kind, model: 'mid-model' }, ctx), /runs on the strong model/);
      assert.doesNotThrow(() => credit.validateTask({ ...base, kind, model: 'vendor-strong-model-2' }, ctx));
    }
    for (const kind of ['record-fixes', 'docs', 'sweeps', 'vuln-auditor']) {
      assert.throws(() => credit.validateTask({ ...base, kind, model: 'cheap-model' }, ctx), /needs the mid model or better/);
      assert.doesNotThrow(() => credit.validateTask({ ...base, kind, model: 'mid-model' }, ctx));
    }
    assert.doesNotThrow(() => credit.validateTask({ ...base, kind: 'code-reading', model: 'cheap-model' }, ctx));
  });

  test('red: with no models set in §16 the floor cannot be checked, so the job is refused', () => {
    const bare = credit.creditContext({});
    assert.throws(() => credit.validateTask({ ...base, kind: 'docs', model: 'anything' }, bare), /needs models\.mid or models\.strong set/);
    assert.throws(() => credit.validateTask({ ...base, kind: 'security-auditor', model: 'anything' }, bare), /needs models\.strong set/);
  });

  test('red: module-tester may write only under the test roots', () => {
    const t = { ...base, kind: 'module-tester', model: 'strong-model' };
    assert.throws(() => credit.validateTask({ ...t, scope: ['src/x.ts'] }, ctx), /writes test files only/);
    assert.throws(() => credit.validateTask({ ...t, scope: ['test/unit/x.test.js', 'README.md'] }, ctx), /writes test files only/);
    assert.doesNotThrow(() => credit.validateTask({ ...t, scope: ['test/integration/**', 'tests/unit/x.py'] }, ctx));
  });

  test('the allow list names whole commands only; a read-only kind may write its records and nothing else', () => {
    const c2 = credit.creditContext({ models: { mid: 'mid-model' }, features: { orchestrator: { credit: { seatCommands: { 'module-tester': ['make test-unit'] } } } } });
    const auditor = credit.allowList({ kind: 'vuln-auditor', key: 'k1', scope: ['src/**'] }, c2);
    assert.equal(auditor.filter((x) => x.startsWith('Bash(')).some((x) => x.includes('*')), false);
    assert.deepEqual(auditor.filter((x) => x.startsWith('Edit(src')), []);
    assert.ok(auditor.includes('Edit(tasks/k1.md)'));
    const tester = credit.allowList({ kind: 'module-tester', key: 'k1', scope: ['test/**'] }, c2);
    assert.ok(tester.includes('Bash(make test-unit)'));
    assert.equal(auditor.includes('Bash(make test-unit)'), false);
  });

  test('red: a brief citing a file absent from the job folder is refused, one line per file; outputs it may create are exempt', () => {
    const r = rig({ files: { 'docs/present.md': 'here\n' } });
    writeFileSync(r.brief, 'Read docs/present.md and docs/missing.md:12, then update tasks/k1.md.\n');
    const p = cli(r, 'complete.jsonl', ['credit-prep', 'c1', 't1', '--key', 'k1', '--kind', 'record-fixes', '--scope', 'tasks/k1.md', '--worktree', r.repo, '--brief', r.brief, '--model', 'mid-model']);
    assert.equal(p.status, 3, p.out);
    assert.match(p.out, /refused: brief cites docs\/missing\.md, which is not in /);
    assert.doesNotMatch(p.out, /present\.md|tasks\/k1\.md/);
    const ok = cli(r, 'complete.jsonl', ['credit-prep', 'c1', 't1', '--key', 'k1', '--kind', 'record-fixes', '--scope', 'tasks/k1.md', '--worktree', r.repo, '--brief', r.brief, '--model', 'mid-model', '--allow-missing']);
    assert.equal(ok.status, 0, ok.out);
  });
});

describe('the workers switch and the feature gate', () => {
  test('red: workers off → credit-run refuses (exit 3); --all-queued starts nothing; credit turns them back on', () => {
    const r = rig();
    const prep = cli(r, 'complete.jsonl', ['credit-prep', 'c1', 't1', '--key', 'k1', '--kind', 'docs', '--scope', 'README.md', '--worktree', r.repo, '--brief', r.brief, '--model', 'mid-model']);
    assert.equal(prep.status, 0);
    assert.match(cli(r, 'complete.jsonl', ['set', 'workers']).stdout, /workers: credit \(default, no switch file\)/);
    assert.match(cli(r, 'complete.jsonl', ['set', 'workers', 'off']).stdout, /workers: off/);
    assert.equal(cli(r, 'complete.jsonl', ['credit-run', 'c1', 't1']).status, 3);
    const q = cli(r, 'complete.jsonl', ['credit-run', '--all-queued']);
    assert.equal(q.status, 3);
    assert.match(q.stdout, /NOT STARTED c1\/t1: workers are off/);
    cli(r, 'complete.jsonl', ['set', 'workers', 'credit']);
    assert.equal(cli(r, 'complete.jsonl', ['credit-run', '--all-queued']).status, 0);
  });

  test('red: with credit.enabled false every credit command says so and runs nothing', () => {
    const { repo } = scratchRepo();
    const root = join(tmp('nocredit'), 'orch');
    for (const args of [['credit'], ['credit-run', '--all-queued'], ['set', 'workers', 'off']]) {
      const p = orch(repo, root, args);
      assert.equal(p.status, 0);
      assert.match(p.stdout, /credit lane: not configured/);
    }
  });
});

describe('fallback: a job the credit cannot run goes to the secondary account, then the primary; job faults never move', () => {
  const fb = (r, fixtures) => prepAndRun(r, fixtures.credit, {
    extra: { ...(fixtures.secondary ? { BUILDER_STUB_FIXTURE_secondary: join(STREAMS, fixtures.secondary) } : {}), ...(fixtures.primary ? { BUILDER_STUB_FIXTURE_primary: join(STREAMS, fixtures.primary) } : {}) },
  });

  test('red: the credit runs out → the secondary account finishes it, without the key or a token; the meter counts only the credit attempt', () => {
    const r = rig({ fallback: true });
    const { run, verdict, starts } = fb(r, { credit: 'billing.jsonl', secondary: 'complete-plan.jsonl' });
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(starts, [{ acct: 'credit', hasKey: true, hasToken: true }, { acct: 'secondary', hasKey: false, hasToken: false }]);
    assert.deepEqual([verdict.status, verdict.account, verdict.billingStop], ['COMPLETE', 'secondary', false]);
    assert.deepEqual(verdict.attempts.map((a) => `${a.account}:${a.failure}`), ['credit:billing']);
    assert.match(run.stdout, /FALLBACK c1\/t1: credit FAILED \(billing\) → secondary account/);
    assert.match(run.stdout, /COMPLETE c1\/t1 \[secondary account\] · cost \$0\.02 \(plan account\)/);
    assert.equal(credit.creditCost(r.creditDir, { account: 'secondary', costUsd: 3, attempts: [{ account: 'credit', costUsd: 0.2 }] }), 0.2);
    assert.equal(credit.creditCost(r.creditDir, { costUsd: 0.4 }), 0.4);
  });

  test('red: the secondary account at its limit (429) → the primary account finishes it', () => {
    const r = rig({ fallback: true });
    const { run, verdict, starts } = fb(r, { credit: 'billing.jsonl', secondary: 'rate-limit-plan.jsonl', primary: 'complete-plan.jsonl' });
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(starts.map((s) => s.acct), ['credit', 'secondary', 'primary']);
    assert.deepEqual([starts[2].hasKey, starts[2].hasToken], [false, false]);
    assert.equal(verdict.account, 'primary');
    assert.deepEqual(verdict.attempts.map((a) => `${a.account}:${a.failure}`), ['credit:billing', 'secondary:rate-limit']);
  });

  test('red: a plan-account fallback whose start reports the API key is stopped (it would bill the credit) and handed on', () => {
    const r = rig({ fallback: true });
    const { verdict } = fb(r, { credit: 'billing.jsonl', secondary: 'complete.jsonl', primary: 'complete-plan.jsonl' });
    assert.equal(verdict.account, 'primary');
    assert.equal(verdict.attempts[1].status, 'REFUSED-KEY-SOURCE');
    assert.match(verdict.attempts[1].keyFault, /apiKeySource is "ANTHROPIC_API_KEY", not none/);
  });

  test('red: a job fault (a denied action) never falls back — one start only', () => {
    const r = rig({ fallback: true });
    const { run, verdict, starts } = fb(r, { credit: 'denied.jsonl', secondary: 'complete-plan.jsonl' });
    assert.equal(run.status, 8);
    assert.equal(starts.length, 1);
    assert.deepEqual([verdict.status, verdict.account, verdict.attempts], ['INCOMPLETE', 'credit', undefined]);
  });
});

describe('the queue and the caps', () => {
  const queue = (root, ids, budgetUsd = 0.5) => {
    ids.forEach((t, i) => {
      const d = join(root, 'runs', 'q1', t);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'task.json'), JSON.stringify({ task: t, budgetUsd }));
      const at = Date.now() / 1000 - 100 + i;
      utimesSync(join(d, 'task.json'), at, at);
    });
  };

  test('red: over the daily cap with a fallback configured, the job goes to the secondary account instead of being skipped', async () => {
    const root = tmp('cap');
    mkdirSync(join(root, 'runs', 'c0', 'spent'), { recursive: true });
    writeFileSync(join(root, 'runs', 'c0', 'spent', 'verdict.json'), JSON.stringify({ costUsd: 59.5, finishedAt: '2026-10-13T06:00:00.000Z' }));
    queue(root, ['t1'], 1);
    const accounts = [];
    const runOne = ({ account }) => {
      accounts.push(account);
      return Promise.resolve({ status: 'COMPLETE', exit: 0, account, failure: null, billingStop: false, costUsd: 0.1, resultLine: 'RESULT: PASS' });
    };
    const lines = [];
    const q = await credit.runQueue({ root, cwd: root, env: {}, now: () => new Date('2026-10-13T08:00:00Z'), runOne, report: (l) => lines.push(l), rateRoot: tmp('rl'), credit: CREDIT({ fallback: ['secondary', 'primary'] }), secondaryConfigDir: '.claude-secondary' });
    assert.deepEqual(accounts, ['secondary']);
    assert.equal(lines[0], 'FALLBACK q1/t1: budget $1 exceeds the $0.50 left today under the $60.00 daily cap → secondary account');
    assert.match(q.summary, /QUEUE: 1 run, 1 COMPLETE, 0 skipped, 0 not started · 1 on a fallback account/);
  });

  test('red: with no fallback, a job over today\'s cap is skipped and stays queued; yesterday\'s spend never counts', async () => {
    const root = tmp('cap2');
    mkdirSync(join(root, 'runs', 'c0', 'spent'), { recursive: true });
    writeFileSync(join(root, 'runs', 'c0', 'spent', 'verdict.json'), JSON.stringify({ costUsd: 59, finishedAt: '2026-10-13T06:00:00.000Z' }));
    mkdirSync(join(root, 'runs', 'c0', 'old'), { recursive: true });
    writeFileSync(join(root, 'runs', 'c0', 'old', 'verdict.json'), JSON.stringify({ costUsd: 30, finishedAt: '2026-10-12T06:00:00.000Z' }));
    queue(root, ['t1'], 5);
    const lines = [];
    const q = await credit.runQueue({ root, cwd: root, env: {}, now: () => new Date('2026-10-13T08:00:00Z'), runOne: () => assert.fail('must not start'), report: (l) => lines.push(l), rateRoot: tmp('rl'), credit: CREDIT() });
    assert.match(lines[0], /^SKIPPED q1\/t1: budget \$5 exceeds the \$1\.00 left today .* stays queued for tomorrow$/);
    assert.deepEqual(q.skipped, ['q1/t1']);
  });

  test('red: once the credit runs out, later tasks in the queue start on the secondary account (no second credit try)', async () => {
    const root = tmp('fbq');
    queue(root, ['t1', 't2']);
    const calls = [];
    const runOne = ({ task, account }) => {
      calls.push(`${task}:${account}`);
      const o = account === 'credit' ? { status: 'FAILED', exit: 1, failure: 'billing', billingStop: true } : { status: 'COMPLETE', exit: 0, failure: null, billingStop: false };
      return Promise.resolve({ ...o, account, costUsd: 0, resultLine: 'RESULT: PASS' });
    };
    const q = await credit.runQueue({ root, cwd: root, env: {}, runOne, rateRoot: tmp('rl'), credit: CREDIT({ fallback: ['secondary'] }), secondaryConfigDir: '.claude-secondary' });
    assert.deepEqual(calls, ['t1:credit', 't1:secondary', 't2:secondary']);
    assert.equal(q.exit, 0);
    assert.match(q.summary, /2 on a fallback account — CREDIT RAN OUT/);
  });

  test('red: with no fallback a billing failure on the first task stops the queue before the second (exit 11)', () => {
    const r = rig();
    for (const t of ['t1', 't2']) {
      const p = cli(r, 'billing.jsonl', ['credit-prep', 'q1', t, '--key', 'k1', '--kind', 'docs', '--scope', 'README.md', '--worktree', r.repo, '--brief', r.brief, '--model', 'mid-model']);
      assert.equal(p.status, 0, p.out);
    }
    const t2 = join(r.creditDir, 'runs', 'q1', 't2', 'task.json');
    const later = Date.now() / 1000 + 5;
    utimesSync(t2, later, later);
    const run = cli(r, 'billing.jsonl', ['credit-run', '--all-queued']);
    assert.equal(run.status, 11, run.out);
    assert.match(run.stdout, /FAILED q1\/t1 .*billing stop/);
    assert.match(run.stdout, /NOT STARTED q1\/t2/);
    assert.match(run.stdout, /QUEUE: 1 run, 0 COMPLETE, 0 skipped, 1 not started — STOPPED ON BILLING/);
    assert.equal(existsSync(join(r.creditDir, 'runs', 'q1', 't2', 'verdict.json')), false);
  });

  test('red: the period and the day are computed in the configured clock; a cap of 0 or a word is refused, never read as "no cap"', () => {
    const p = credit.periodBounds('2026-10-22T19:59:59Z', { renewDay: 23, tzOffsetMinutes: 240 });
    assert.deepEqual(p, { start: '2026-09-22T20:00:00.000Z', end: '2026-10-22T20:00:00.000Z' });
    assert.equal(credit.periodBounds('2026-10-22T20:00:00Z', { renewDay: 23, tzOffsetMinutes: 240 }).start, '2026-10-22T20:00:00.000Z');
    assert.deepEqual(credit.dayBounds('2026-10-13T21:00:00Z', { tzOffsetMinutes: 240 }), { start: '2026-10-13T20:00:00.000Z', end: '2026-10-14T20:00:00.000Z' });
    assert.throws(() => credit.creditConfig({ dailyCapUsd: 0 }), /must be > 0/);
    assert.throws(() => credit.creditConfig({ dailyCapUsd: 'lots' }), /not a number/);
    assert.throws(() => credit.creditConfig({}), /dailyCapUsd is not set/);
    assert.equal(credit.creditConfig({ dailyCapUsd: 5 }).periodBudgetUsd, null);
  });

  test('red: spend sums every in-period verdict across ALL worktrees, once each; unreported cost counts 0 and is listed', () => {
    const { dir, repo } = scratchRepo();
    const wt2 = join(dir, 'wt2');
    git(repo, 'worktree', 'add', '-q', wt2, '-b', 'side');
    const put = (checkout, task, v) => {
      const d = join(checkout, '.pipeline', 'credit', 'runs', 'r1', task);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'verdict.json'), JSON.stringify(v));
    };
    put(repo, 'a', { costUsd: 1.5, finishedAt: '2026-10-10T10:00:00Z' });
    put(wt2, 'b', { costUsd: 2, finishedAt: '2026-10-10T10:00:00Z' });
    put(wt2, 'c', { costUsd: null, finishedAt: '2026-10-10T11:00:00Z' });
    put(wt2, 'd', { costUsd: 9, finishedAt: '2026-09-01T10:00:00Z' }); // another period
    const s = credit.periodSpend({ root: join(repo, '.pipeline', 'credit'), cwd: repo, period: credit.periodBounds('2026-10-10T12:00:00Z', {}) });
    assert.deepEqual([s.spent, s.jobs, s.unreported.length], [3.5, 3, 1]);
  });
});

describe('review before merge', () => {
  test('red: a job that changed files is PENDING; merge is blocked until it is PASSED, or REJECTED and then REVERTED', () => {
    const r = rig();
    const { verdict } = prepAndRun(r, 'complete.jsonl', { tail: [{ _stub: 'write', path: 'tasks/k1.md', text: 'row 1 fixed\n' }] });
    assert.deepEqual([verdict.status, verdict.review, verdict.changed], ['COMPLETE', 'PENDING', ['tasks/k1.md']]);
    const blockers = () => credit.mergeBlockers(r.repo, r.creditDir);
    assert.deepEqual(blockers(), ['c1/t1 review PENDING']);
    assert.match(credit.reviewLine(credit.pendingReviews(r.creditDir)), /^CREDIT-REVIEW: 1 credit job\(s\) changed files and wait for review .*: c1\/t1$/);
    assert.throws(() => credit.signReview({ root: r.creditDir, run: 'c1', task: 't1' }), /needs --by/);
    credit.signReview({ root: r.creditDir, run: 'c1', task: 't1', by: 'orchestrator', reject: 'row 1 cites no command' });
    assert.deepEqual(blockers(), ['c1/t1 review REJECTED']);
    assert.throws(() => credit.signReview({ root: r.creditDir, run: 'c1', task: 't1', by: 'orchestrator', reverted: true }), /changes are still in .*: tasks\/k1\.md/);
    unlinkSync(join(r.repo, 'tasks', 'k1.md'));
    assert.equal(credit.signReview({ root: r.creditDir, run: 'c1', task: 't1', by: 'orchestrator', reverted: true }).review, 'REVERTED');
    assert.deepEqual(blockers(), []);
  });

  test('a read-only job never needs review', () => {
    const r = rig();
    const { verdict } = prepAndRun(r, 'complete.jsonl', { kind: 'code-reading', scope: 'src/**', model: 'cheap-model' });
    assert.equal(verdict.review, 'NOT-NEEDED');
  });
});

describe('re-runs keep the meter, and the review hold reads every verdict file', () => {
  test('red: a finished job is never run again without --rerun; --rerun moves the verdict aside, the meter counts both', () => {
    const r = rig();
    const first = prepAndRun(r, 'complete.jsonl');
    assert.equal(first.run.status, 0, first.run.out);
    const again = cli(r, 'complete.jsonl', ['credit-run', 'c1', 't1']);
    assert.equal(again.status, 3, again.out);
    assert.match(again.out, /already has a verdict \(COMPLETE\) — credit-run c1 t1 --rerun/);
    const rerun = cli(r, 'complete.jsonl', ['credit-run', 'c1', 't1', '--rerun']);
    assert.equal(rerun.status, 0, rerun.out);
    assert.match(rerun.stdout, /RERUN c1\/t1: verdict\.json → verdict\.prev-\d{8}T\d{6}Z\.json/);
    const files = credit.verdictFiles(first.dir).map((f) => f.live);
    assert.deepEqual(files.sort(), [false, true]);
    const meter = cli(r, 'complete.jsonl', ['credit']);
    assert.match(meter.stdout, /\(2 jobs\)/, meter.out);
  });

  test('red: --rerun is refused while the review is PENDING or REJECTED, and after FAILED-SCOPE until --cleared-by names who cleared it', () => {
    const root = tmp('rq');
    const dir = join(root, 'runs', 'c1', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task.json'), '{}');
    for (const review of ['PENDING', 'REJECTED']) {
      writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ status: 'COMPLETE', review }));
      assert.throws(() => credit.requeue({ root, run: 'c1', task: 't1' }), new RegExp(`review is ${review}`));
    }
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ status: 'FAILED-SCOPE', review: 'NOT-NEEDED' }));
    assert.throws(() => credit.requeue({ root, run: 'c1', task: 't1' }), /ended FAILED-SCOPE .* --cleared-by/);
    const ok = credit.requeue({ root, run: 'c1', task: 't1', clearedBy: 'lead', now: new Date('2026-10-15T06:15:00Z') });
    assert.equal(ok.verdictTo, 'verdict.prev-20261015T061500Z.json');
    assert.equal(JSON.parse(readFileSync(join(dir, ok.verdictTo), 'utf8')).clearedBy, 'lead');
    assert.equal(existsSync(join(dir, 'verdict.json')), false);
    assert.throws(() => credit.requeue({ root, run: 'c1', task: 't1' }), /already queued/);
  });

  test('red: a task id outside the id rule never reaches the file system; a bad verdict file name is refused', () => {
    assert.throws(() => credit.taskDir(tmp('id'), 'c1', '../x'), /bad task id/);
    assert.throws(() => credit.signReview({ root: tmp('sv'), run: 'c1', task: 't1', by: 'me', verdict: '../verdict.json' }), /bad verdict file/);
  });

  test('a moved verdict still PENDING is listed and signed with --verdict', () => {
    const root = tmp('mv');
    const dir = join(root, 'runs', 'c1', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task.json'), '{}');
    writeFileSync(join(dir, 'verdict.pass1.json'), JSON.stringify({ review: 'PENDING', changed: ['a.md'] }));
    const p = credit.pendingReviews(root);
    assert.deepEqual(p.map((x) => x.verdict), ['verdict.pass1.json']);
    assert.match(credit.reviewLine(p), /c1\/t1 \(verdict\.pass1\.json\)/);
    assert.equal(credit.signReview({ root, run: 'c1', task: 't1', by: 'me', verdict: 'verdict.pass1.json' }).review, 'PASSED');
    assert.deepEqual(credit.pendingReviews(root), []);
  });
});

describe('the queue: order, refusals, one runner, reservations', () => {
  const job = (root, id, kind, at) => {
    const d = join(root, 'runs', 'q1', id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'task.json'), JSON.stringify({ task: id, kind, budgetUsd: 0.5 }));
    utimesSync(join(d, 'task.json'), at, at);
    return d;
  };

  test('read-only kinds run first, writing kinds last, creation order inside each group', () => {
    const root = tmp('ord');
    const t0 = Date.now() / 1000 - 100;
    job(root, 'w1', 'docs', t0);
    job(root, 'r1', 'code-reading', t0 + 1);
    job(root, 'w2', 'module-tester', t0 + 2);
    job(root, 'r2', 'standards-auditor', t0 + 3);
    assert.deepEqual(credit.runOrder(credit.queuedTasks(root)).map((q) => q.task), ['r1', 'r2', 'w1', 'w2']);
  });

  test('red: a refused job is listed with its reason and not counted as run (exit 3); a second runner on the queue is refused', async () => {
    const root = tmp('ref');
    const t0 = Date.now() / 1000 - 100;
    job(root, 'ok', 'code-reading', t0);
    job(root, 'no', 'code-reading', t0 + 1);
    const runOne = ({ task, account }) => (task === 'no' ? Promise.reject(new Error('refused: worktree x is dirty')) : Promise.resolve({ status: 'COMPLETE', exit: 0, account, failure: null, costUsd: 0.1, resultLine: 'RESULT: PASS' }));
    const q = await credit.runQueue({ root, cwd: root, env: {}, now: () => new Date('2026-10-13T08:00:00Z'), runOne, rateRoot: tmp('rl'), credit: CREDIT() });
    assert.equal(q.exit, 3);
    assert.deepEqual(q.ran.map((x) => x.id), ['q1/ok']);
    assert.match(q.summary, /QUEUE: 1 run, 1 COMPLETE, 0 skipped, 0 not started · 1 refused\n {2}REFUSED q1\/no: refused: worktree x is dirty/);
    assert.equal(existsSync(join(root, 'runner.lock')), false, 'the runner lock is released');
    writeFileSync(join(root, 'runner.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(credit.runQueue({ root, cwd: root, env: {}, runOne, rateRoot: tmp('rl'), credit: CREDIT() }), /a credit runner \(pid \d+\) is already running/);
    writeFileSync(join(root, 'runner.lock'), JSON.stringify({ pid: 2147483646 }));
    const taken = await credit.runQueue({ root, cwd: root, env: {}, now: () => new Date('2026-10-13T08:00:00Z'), runOne, rateRoot: tmp('rl'), credit: CREDIT() });
    assert.equal(taken.exit, 3, 'a dead holder is taken over (positive control: the queue ran)');
  });

  test('red: a running job reserves its budget — a second runner sees the allowance minus it; a dead or plan-account reservation counts nothing', () => {
    const root = tmp('res');
    const d = job(root, 'run', 'code-reading', Date.now() / 1000);
    const date = new Date('2026-10-13T08:00:00Z');
    const before = credit.spendDown(root, date, CREDIT(), root).allowance;
    writeFileSync(join(d, 'running.json'), JSON.stringify({ pid: process.pid, budgetUsd: 20, account: 'credit' }));
    assert.equal(credit.spendDown(root, date, CREDIT(), root).allowance, before - 20);
    writeFileSync(join(d, 'running.json'), JSON.stringify({ pid: 2147483646, budgetUsd: 20, account: 'credit' }));
    assert.equal(credit.reservedUsd({ root, cwd: root }), 0);
    writeFileSync(join(d, 'running.json'), JSON.stringify({ pid: process.pid, budgetUsd: 20, account: 'secondary' }));
    assert.equal(credit.reservedUsd({ root, cwd: root }), 0);
  });

  test('red: a negative cost in a verdict is unreported, never negative spend', () => {
    const root = tmp('neg');
    mkdirSync(join(root, 'runs', 'c0', 'x1'), { recursive: true });
    writeFileSync(join(root, 'runs', 'c0', 'x1', 'verdict.json'), JSON.stringify({ costUsd: -50, finishedAt: '2026-10-13T06:00:00.000Z' }));
    const s = credit.spendDown(root, new Date('2026-10-13T08:00:00Z'), CREDIT(), root);
    assert.deepEqual([s.todaySpent, s.unreported.length], [0, 1]);
  });

  test('red: one credit job per target worktree — a live holder refuses, a dead one is taken over', () => {
    const env = { BUILDER_ORCH_DIR: tmp('tl') };
    const wt = tmp('target');
    const f = credit.takeTargetLock(env, wt, 'c1/t1');
    assert.throws(() => credit.takeTargetLock(env, wt, 'c1/t2'), /another credit job \(c1\/t1, pid \d+\) is running/);
    writeFileSync(f, JSON.stringify({ pid: 2147483646, job: 'old' }));
    assert.equal(credit.takeTargetLock(env, wt, 'c1/t3'), f);
    assert.match(readFileSync(f, 'utf8'), /c1\/t3/);
  });
});

describe('who left the worktree dirty, the queue a job is in, and when the credit lane is busy', () => {
  test('a dirty refusal names the credit job whose verdict (live or moved aside) changed those files', () => {
    const root = tmp('dirt');
    const wt = tmp('wt');
    const d = join(root, 'runs', 'c1', 'tester');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'task.json'), JSON.stringify({ worktree: wt }));
    writeFileSync(join(d, 'verdict.prev-20261015T000000Z.json'), JSON.stringify({ review: 'PASSED', changed: ['test/a.spec.ts'] }));
    assert.match(credit.dirtLeftBy(root, wt, ['?? test/a.spec.ts']), /left by credit job c1\/tester \[verdict\.prev-20261015T000000Z\.json\] \(review PASSED: test\/a\.spec\.ts\)/);
    assert.equal(credit.dirtLeftBy(root, wt, ['?? other.ts']), '');
  });

  test('red: --queue must be a worktree of this repository', () => {
    const { repo } = scratchRepo();
    const other = scratchRepo().repo;
    assert.equal(credit.queueRootOf(repo, repo), join(repo, '.pipeline', 'credit'));
    assert.throws(() => credit.queueRootOf(other, repo), /not a worktree of this repository/);
    assert.throws(() => credit.queueRootOf(join(repo, 'nope'), repo), /does not exist/);
  });

  test('creditBusy: busy on another worktree\'s queued work; never while the lane has a seat job of its own (queued, or since its result)', () => {
    const { dir, repo } = scratchRepo();
    git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', join(dir, 'lane-a'), 'dev');
    const laneA = join(dir, 'lane-a');
    const put = (wt, id, kind, target) => {
      const d = join(wt, '.pipeline', 'credit', 'runs', 'c1', id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'task.json'), JSON.stringify({ kind, worktree: target }));
      return d;
    };
    assert.equal(credit.creditBusy({ cwd: repo, laneWorktree: laneA }), null);
    put(repo, 'other', 'docs', join(dir, 'lane-b'));
    assert.match(credit.creditBusy({ cwd: repo, laneWorktree: laneA }), /1 job\(s\) queued for another worktree/);
    const own = put(laneA, 'own-docs', 'docs', laneA);
    assert.match(credit.creditBusy({ cwd: repo, laneWorktree: laneA }), /queued for another worktree/, 'a docs job of its own runs no seat');
    const seat = put(laneA, 'own-seat', 'security-auditor', laneA);
    assert.equal(credit.creditBusy({ cwd: repo, laneWorktree: laneA }), null);
    writeFileSync(join(seat, 'verdict.json'), '{}');
    assert.match(credit.creditBusy({ cwd: repo, laneWorktree: laneA }), /queued for another worktree/);
    assert.equal(credit.creditBusy({ cwd: repo, laneWorktree: laneA, since: new Date(Date.now() - 60000).toISOString() }), null, 'a seat job prepared since the result, even finished');
    writeFileSync(join(own, 'verdict.json'), '{}');
  });

  test('CREDIT-FILL names how far behind and what to queue, for a lapsing budget', () => {
    const st = { cfg: { lapses: true }, left: 150, budget: 200, spent: 10, elapsed: 0.5, daysLeft: 15, label: { last: '2026-11-21' }, fillCandidates: ['P5 docs of k1 (docs)'] };
    assert.equal(credit.pressureLine(st), 'CREDIT-FILL: queue light jobs (code-reading, record-fixes, docs, sweeps, vuln-auditor) — $90.00 behind pace ($150.00 left, 15 day(s) to renewal): P5 docs of k1 (docs)');
  });
});
