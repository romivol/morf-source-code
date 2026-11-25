// `morf uninstall <repo> ...` removes only what came from that repository.
// It used to ignore the argument, so `morf uninstall <repo> --all` removed
// everything morf manages.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, tmp, cleanup, makeRepo, run, write, readJson, exists, snapshot, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, NAMES, names, ctx, newProject } = projectKit(m);
const { sameRepo } = await import('../../src/repo/url.js');

const agent = name => `---\nname: ${name}\ndescription: d\n---\nbody\n`;
const repoWith = (...agents) => makeRepo(Object.fromEntries(agents.map(a => [`agents/${a}.md`, agent(a)])));
const installed = name => exists(m.home, `.claude/agents/${name}.md`);

const cwd = tmp('morf-global-');
const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv],
  { cwd, encoding: 'utf8', env: { ...process.env, MORF_ASCII: '1' } });

function installBoth() {
  const a = repoWith('alpha-one', 'alpha-two');
  const b = repoWith('beta-one');
  assert.equal(cli('install', a.dir, '--target', 'claude').status, 0);
  assert.equal(cli('install', b.dir, '--target', 'claude').status, 0);
  assert.ok(installed('alpha-one') && installed('alpha-two') && installed('beta-one'));
  return { a, b };
}

test('uninstall <repo> --all removes only what came from that repository', () => {
  const { a, b } = installBoth();
  const res = cli('uninstall', a.dir, '--all', '-y');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.ok(!installed('alpha-one') && !installed('alpha-two'), 'items from the named repo remain');
  assert.ok(installed('beta-one'), 'an item from another repository was removed');
  assert.equal(cli('uninstall', b.dir, '--all', '-y').status, 0);
  assert.ok(!installed('beta-one'));
});

test('the dangerous case: a repo nothing was installed from removes nothing and exits 1', () => {
  installBoth();
  const before = snapshot(join(m.home, '.claude'));
  const stranger = repoWith('gamma');
  for (const repo of [stranger.dir, 'https://github.com/someone/else.git', 'github.com/someone/else', 'git@github.com:someone/else.git']) {
    const res = cli('uninstall', repo, '--all', '-y');
    assert.equal(res.status, 1, `${repo}: ${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /Nothing morf manages here was installed from/);
    assert.deepEqual(snapshot(join(m.home, '.claude')), before, `${repo}: something was removed`);
  }
  // Without a repo argument, --all still means everything.
  assert.equal(cli('uninstall', '--all', '-y').status, 0);
  assert.ok(!installed('alpha-one') && !installed('beta-one'));
});

test('uninstall <repo> with item names only touches that repository', () => {
  const { a, b } = installBoth();
  // beta-one is installed, but not from repository a.
  const wrong = cli('uninstall', a.dir, '--agent', 'beta-one', '-y');
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.ok(installed('beta-one'));

  const right = cli('uninstall', a.dir, '--agent', 'alpha-one', '-y');
  assert.equal(right.status, 0, right.stdout + right.stderr);
  assert.ok(!installed('alpha-one') && installed('alpha-two') && installed('beta-one'));

  // A dry run names only that repository's items.
  const dry = cli('uninstall', b.dir, '--all', '--dry-run');
  assert.match(dry.stdout, /beta-one/);
  assert.doesNotMatch(dry.stdout, /alpha-two/);
  assert.ok(installed('beta-one'));
  cli('uninstall', '--all', '-y');
});

test('an unsafe repo argument is refused like anywhere else', () => {
  installBoth();
  const res = cli('uninstall', "ext::sh -c 'id'", '--all', '-y');
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /not valid|not allowed/i);
  assert.ok(installed('alpha-one') && installed('beta-one'));
  cli('uninstall', '--all', '-y');
});

test('the same remote under different spellings is one repository', () => {
  const same = ['https://github.com/acme/agents.git', 'https://github.com/acme/agents', 'github.com/acme/agents',
    'git@github.com:acme/agents.git', 'ssh://git@github.com/acme/agents.git', 'https://GitHub.com/acme/agents/'];
  for (const x of same) for (const y of same) assert.ok(sameRepo(x, y), `${x} vs ${y}`);
  for (const other of ['https://github.com/acme/other.git', 'https://gitlab.com/acme/agents.git', 'https://github.com/Acme/agents', './agents']) {
    assert.ok(!sameRepo(same[0], other), other);
  }
  // Local directories compare by location.
  const dir = tmp('morf-local-');
  write(dir, 'x/keep', '');          // a bare name counts as a path only if it exists
  assert.ok(sameRepo(dir, join(dir, 'sub', '..')));
  assert.ok(sameRepo('./x', 'x', dir) && sameRepo(join(dir, 'x'), './x', dir));
  assert.ok(!sameRepo(dir, join(dir, 'other')));
  assert.ok(!sameRepo(null, dir) && !sameRepo(dir, undefined));

  // And a record written under one spelling is matched by another.
  write(m.home, '.morf/installed.json', JSON.stringify({ version: 3, items: { 'agent:remote-one:claude': {
    type: 'agent', name: 'remote-one', target: 'claude', project: '', repo: 'https://github.com/acme/agents.git',
    repoKey: 'github.com/acme/agents', hash: 'h', ref: null,
  } } }));
  write(m.home, '.claude/agents/remote-one.md', agent('remote-one'));
  const miss = cli('uninstall', 'github.com/acme/other', '--all', '-y');
  assert.equal(miss.status, 1);
  assert.ok(installed('remote-one'));
  const hit = cli('uninstall', 'git@github.com:acme/agents.git', '--all', '-y');
  assert.equal(hit.status, 0, hit.stdout + hit.stderr);
  assert.ok(!installed('remote-one'));
});

test('project mode: uninstall <repo> removes only that source', async () => {
  const a = repoWith('alpha-one', 'alpha-two');
  const b = repoWith('beta-one');
  const root = await newProject();
  const install = repo => run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: NAMES(), all: true, targets: ['claude', 'cursor'], force: false, ref: null, yes: true, allowExec: true,
  }, ctx(root)));
  assert.equal((await install(a)).code, 0);
  assert.equal((await install(b)).code, 0);
  const un = (over) => run(() => m.projectUninstallCommand({ names: NAMES(), all: false, targets: [], yes: true, ...over }, ctx(root)));

  // A repository nothing here came from.
  const before = snapshot(root);
  for (const repoArg of [repoWith('gamma').dir, 'https://github.com/someone/else.git']) {
    const res = await un({ repoArg, all: true });
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /Nothing morf manages here was installed from/);
    assert.deepEqual(snapshot(root), before);
  }
  // A name that is installed, but from the other repository.
  assert.equal((await un({ repoArg: a.dir, names: names({ agent: ['beta-one'] }) })).code, 1);
  assert.deepEqual(snapshot(root), before);

  const res = await un({ repoArg: a.dir, all: true });
  assert.equal(res.code, 0, res.out);
  assert.ok(!exists(root, '.claude/agents/alpha-one.md') && !exists(root, '.cursor/agents/alpha-two.md'));
  assert.ok(exists(root, '.claude/agents/beta-one.md') && exists(root, '.cursor/agents/beta-one.md'));
  const pf = readJson(root, 'morf.json');
  assert.equal(pf.sources.length, 1);
  assert.deepEqual(pf.sources[0].items.map(i => i.name), ['beta-one']);
  assert.deepEqual(readJson(root, 'morf.lock.json').sources.map(s => s.items.map(i => i.name)), [['beta-one']]);
});
