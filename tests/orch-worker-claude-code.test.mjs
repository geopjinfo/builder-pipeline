/**
 * The Claude Code worker adapter's --settings pin and the gate-launch policy wiring
 * (plan M4, REQ-402, REQ-404, D40). The credit-lane parts of the adapter are covered by orch-credit.test.mjs.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { PACK, lanes, orch, profileText, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const cc = require(join(PACK, 'scripts', 'lib', 'orch-worker-claude-code.cjs'));
const state = require(join(PACK, 'scripts', 'lib', 'orch-state.cjs'));
const profile = require(join(PACK, 'scripts', 'lib', 'profile.cjs'));

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const MARKER = 'https://marker-' + 'route.example.net/' + 'v1';

function accountsProfile(account = {}) {
  return profileText({
    orchestrator: { launchCommand: 'start-worker --brief "{brief}" --lane {lane}' },
    extraFeatures: { accounts: { state: 'on', accounts: { alpha: { worker: 'claude-code', pays: 'subscription', content: 'any', command: 'start-worker --brief "{brief}"', ...account } } } },
  });
}

/** An accounts home holding alpha's dir and its own settings file. */
function home(settings = { env: { ALPHA_MARK: '1' } }) {
  const h = tmp('home');
  temps.push(h);
  mkdirSync(join(h, 'accounts', 'alpha'), { recursive: true });
  writeFileSync(join(h, 'accounts', 'alpha', 'settings.json'), JSON.stringify(settings));
  return h;
}

function claimedRun(repo, root, run, extra = {}) {
  // the run records the profile's registry accounts (M3): placement puts the lane on alpha, the only account
  const accounts = profile.accounts.list(profile.parse(readFileSync(join(repo, 'PIPELINE_PROFILE.md'), 'utf8')).settings);
  state.init(root, run, lanes(1, extra), { repo, target: 'dev', worktreeBase: join(repo, '..'), worktreePrefix: 'wt-', preflightMode: 'parallel', accounts });
  state.approve(root, run, 'human');
  state.setLane(root, run, 'l1', { status: 'CLAIMED' });
  return state.load(root, run).lanes.l1;
}

function filesOf(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesOf(dir, r));
    else out.push(r);
  }
  return out.sort();
}

describe('the --settings pin (pure)', () => {
  test("red: REQ-404 pin() carries the account's env block, its config dir and its baseUrl; deny rules per path", () => {
    const p = cc.pin({ account: { name: 'alpha', baseUrl: 'https://gw.example.com/v1' }, configDir: '/cfg/alpha', accountSettings: { env: { ALPHA_MARK: '1' }, apiKeyHelper: 'h' }, denyPaths: ['./docs/**', './README.md'] });
    assert.deepEqual(p.env, { ALPHA_MARK: '1', ANTHROPIC_BASE_URL: 'https://gw.example.com/v1', CLAUDE_CONFIG_DIR: '/cfg/alpha' });
    assert.deepEqual(p.permissions.deny, ['Read(./docs/**)', 'Edit(./docs/**)', 'Write(./docs/**)', 'Read(./README.md)', 'Edit(./README.md)', 'Write(./README.md)']);
    assert.equal(p.apiKeyHelper, undefined, 'the pin never copies the key helper');
    const bare = cc.pin({ account: { name: 'alpha' }, configDir: null, accountSettings: null, denyPaths: [] });
    assert.deepEqual(bare, { env: {} });
  });

  test('REQ-404 withSettings fills {settings} when the template names it, else appends --settings', () => {
    assert.equal(cc.withSettings('run --brief b --settings {settings}', '/p/l1.json'), 'run --brief b --settings /p/l1.json');
    assert.equal(cc.withSettings('run --brief b', '/p/l1.json'), 'run --brief b --settings "/p/l1.json"');
  });
});

describe('gate-launch: the settings scan and the pin (REQ-404)', () => {
  test('red: REQ-404 on a clean project the launch command carries --settings and the pin file holds the account env block at 0600', () => {
    const h = home();
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile() });
    temps.push(dir);
    claimedRun(repo, root, 'ok');
    const r = orch(repo, root, ['gate-launch', 'ok', 'l1'], { BUILDER_ACCOUNTS_HOME: h });
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.match(j.launch, /^start-worker --brief ".*l1\.md" --settings ".*l1\.settings\.json"$/); // the account's own command wins over launchCommand (M3), the pin follows it
    assert.ok(existsSync(j.settings), 'pin file');
    const pin = JSON.parse(readFileSync(j.settings, 'utf8'));
    assert.equal(pin.env.ALPHA_MARK, '1');
    assert.equal(pin.env.CLAUDE_CONFIG_DIR, join(h, 'accounts', 'alpha'));
    if (process.platform !== 'win32') assert.equal(statSync(j.settings).mode & 0o777, 0o600);
  });

  test('red: REQ-404 a project settings file with a marker env.ANTHROPIC_BASE_URL: exit 3 names the key and the file, the marker value is absent, nothing launches', () => {
    const h = home();
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile(), files: { '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: MARKER } }) } });
    temps.push(dir);
    const l = claimedRun(repo, root, 'mk');
    const r = orch(repo, root, ['gate-launch', 'mk', 'l1'], { BUILDER_ACCOUNTS_HOME: h });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /E_SETTINGS: .*\.claude[\\/]settings\.json: env\.ANTHROPIC_BASE_URL/);
    assert.ok(!r.out.includes(MARKER) && !r.out.includes('marker-route'), 'the value leaked');
    assert.ok(!r.out.includes('start-worker'), 'the launch command was printed');
    assert.equal(existsSync(join(root, 'runs', 'mk', 'pins', 'l1.settings.json')), false, 'no pin was written');
    const events = readFileSync(join(root, 'runs', 'mk', 'events.jsonl'), 'utf8');
    assert.match(events, /"launch\.refused"/);
    assert.ok(!events.includes('marker-route'));
    assert.equal(existsSync(l.worktree), false);
  });

  test('red: REQ-404 the lane worktree\'s settings.local.json is scanned too, and a hook not in the lock refuses', () => {
    const h = home();
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile() });
    temps.push(dir);
    const l = claimedRun(repo, root, 'wk');
    mkdirSync(join(l.worktree, '.claude'), { recursive: true }); // a worktree folder a person made by hand
    writeFileSync(join(l.worktree, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/x.cjs' }] }] } }));
    const r = orch(repo, root, ['gate-launch', 'wk', 'l1'], { BUILDER_ACCOUNTS_HOME: h });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /settings\.local\.json: hooks\.PreToolUse\[0\]\.hooks\[0\] — a hook not recorded in builder\.lock\.json/);
  });

  test('red: REQ-401 a public-only account on a private project: exit 3 naming the class and the account', () => {
    const h = home();
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile({ content: 'public' }) });
    temps.push(dir);
    claimedRun(repo, root, 'pb');
    const r = orch(repo, root, ['gate-launch', 'pb', 'l1'], { BUILDER_ACCOUNTS_HOME: h });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /E_CONTENT_PUBLIC: account alpha is content "public" and the project is visibility private/);
  });
});

describe('gate-launch: path roots (REQ-402)', () => {
  test('red: REQ-402 a path-root account launches in a sparse worktree holding only the roots, with deny rules in the pin; a claimed file outside is refused naming the path', () => {
    const h = home();
    const files = { 'src/public/a.ts': 'a\n', 'src/private/c.ts': 'c\n', 'docs/d.md': 'd\n' };
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile({ content: ['src/public'] }), files });
    temps.push(dir);
    const l = claimedRun(repo, root, 'pr', { ownedFiles: ['src/public/a.ts'] });
    const r = orch(repo, root, ['gate-launch', 'pr', 'l1'], { BUILDER_ACCOUNTS_HOME: h });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(filesOf(l.worktree), ['src/public/a.ts']);
    const pin = JSON.parse(readFileSync(JSON.parse(r.stdout).settings, 'utf8'));
    assert.ok(pin.permissions.deny.includes('Read(./docs/**)'), JSON.stringify(pin.permissions.deny));
    assert.ok(pin.permissions.deny.includes('Write(./src/private/**)'));
    assert.ok(!pin.permissions.deny.some((d) => d.includes('src/public')));

    const { dir: dir2, repo: repo2, root: root2 } = scratchRepo({ profile: accountsProfile({ content: ['src/public'] }), files });
    temps.push(dir2);
    claimedRun(repo2, root2, 'px', { ownedFiles: ['src/public/a.ts', 'src/private/c.ts'] });
    const bad = orch(repo2, root2, ['gate-launch', 'px', 'l1'], { BUILDER_ACCOUNTS_HOME: h });
    assert.equal(bad.status, 3, bad.out);
    assert.match(bad.out, /E_PATH_ROOTS: src\/private\/c\.ts lies outside the path roots of account alpha/);
    assert.ok(!bad.out.includes('c\n'));
  });

  test('red: REQ-402 an existing worktree that is not sparse on the roots is refused naming the path', () => {
    const h = home();
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile({ content: ['src/public'] }), files: { 'src/public/a.ts': 'a\n', 'docs/d.md': 'd\n' } });
    temps.push(dir);
    const l = claimedRun(repo, root, 'ns', { ownedFiles: ['src/public/a.ts'] });
    mkdirSync(l.worktree, { recursive: true });
    const r = orch(repo, root, ['gate-launch', 'ns', 'l1'], { BUILDER_ACCOUNTS_HOME: h });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /E_PATH_ROOTS: worktree .*wt-ns-l1 is not a sparse checkout of the roots src\/public/);
  });
});
