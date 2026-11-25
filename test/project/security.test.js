// Values from morf.json, morf.lock.json, the command line and the install
// record must never reach git as an option or as a transport helper, and no
// git process may start before those values have been validated.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sandbox, tmp, cleanup, makeRepo, run, snapshot, write, exists, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, NAMES, names, ctx, newProject, stored } = projectKit(m);

const HASH = 'sha256:' + '0'.repeat(64);
const COMMIT = 'a'.repeat(40);

// A place the injected command would write to if it ever ran.
function marker() {
  const dir = tmp('morf-mark-');
  return { dir, file: join(dir, 'MARK').replace(/\\/g, '/') };
}
const injected = mark => `--upload-pack=touch ${mark.file};`;
const extHelper = mark => `ext::sh -c 'touch ${mark.file}'`;

function projectWith(root, { pfRepo, lockRepo, ref = 'main', lockRef = ref }) {
  const item = { type: 'agent', name: 'bug-finder' };
  if (pfRepo !== undefined) {
    write(root, 'morf.json', JSON.stringify({ version: 1, sources: [{ repo: pfRepo, ref, targets: ['claude'], items: [item] }] }));
  }
  if (lockRepo !== undefined) {
    write(root, 'morf.lock.json', JSON.stringify({ lockfileVersion: 1,
      sources: [{ repo: lockRepo, ref: lockRef, commit: COMMIT, items: [{ ...item, hash: HASH }] }] }));
  }
}

// Every project command, with flags that would otherwise let it run.
const COMMANDS = {
  'sync': (root) => m.syncCommand({ yes: true, allowExec: true }, ctx(root)),
  'sync --dry-run': (root) => m.syncCommand({ dryRun: true }, ctx(root)),
  'sync --frozen': (root) => m.syncCommand({ frozen: true, yes: true, allowExec: true }, ctx(root)),
  'sync --check': (root) => m.syncCommand({ check: true }, ctx(root)),
  'update': (root) => m.syncCommand({ update: true, yes: true, allowExec: true }, ctx(root)),
  'install': (root, repoDir) => m.projectInstallCommand({
    repoArg: repoDir, names: names({ rule: ['ts-style'] }), all: false, targets: ['claude'], force: false, ref: null,
    yes: true, allowExec: true,
  }, ctx(root)),
  'uninstall': (root) => m.projectUninstallCommand({ names: NAMES(), all: true, targets: [], yes: true }, ctx(root)),
};

// Run a command that must be refused: exit 1, nothing written, no git at all.
async function assertRefused(label, fn, root, mark) {
  m.gitCalls.length = 0;
  const before = snapshot(root);
  let res;
  try {
    res = await run(fn);
  } catch (e) {
    assert.fail(`${label}: threw instead of returning 1: ${e.message}`);
  }
  assert.equal(res.code, 1, `${label}: ${res.out}`);
  assert.equal(m.gitCalls.length, 0, `${label}: a git process was started: git ${m.gitCalls.map(c => c.args[0]).join(', git ')}`);
  assert.ok(!exists(mark.dir, 'MARK'), `${label}: the injected command ran`);
  assert.deepEqual(snapshot(root), before, `${label}: files changed`);
  return res;
}

test('the reported reproduction: an option-shaped repo is refused by every command, and nothing runs', async () => {
  const repo = makeRepo();
  for (const [label, fn] of Object.entries(COMMANDS)) {
    const mark = marker();
    const root = await newProject();
    projectWith(root, { pfRepo: injected(mark), lockRepo: injected(mark) });
    const res = await assertRefused(label, () => fn(root, repo.dir), root, mark);
    assert.match(res.out, /not valid|not a valid|not allowed/i, label);
  }
});

test('the same value in the project file only, and in the lockfile only', async () => {
  const repo = makeRepo();
  for (const [label, fn] of Object.entries(COMMANDS)) {
    const a = marker();
    const onlyPf = await newProject();
    projectWith(onlyPf, { pfRepo: injected(a) });
    await assertRefused(`${label} (project file only)`, () => fn(onlyPf, repo.dir), onlyPf, a);

    const b = marker();
    const onlyLock = await newProject();
    projectWith(onlyLock, { pfRepo: stored(onlyLock, repo), lockRepo: injected(b) });
    await assertRefused(`${label} (lockfile only)`, () => fn(onlyLock, repo.dir), onlyLock, b);
  }
});

test('a transport-helper repo (ext::...) is refused', async () => {
  const repo = makeRepo();
  for (const [label, fn] of Object.entries(COMMANDS)) {
    const mark = marker();
    const root = await newProject();
    projectWith(root, { pfRepo: extHelper(mark), lockRepo: extHelper(mark) });
    await assertRefused(label, () => fn(root, repo.dir), root, mark);
  }
});

test('other unsafe repo and ref values in the project files are refused', async () => {
  const repo = makeRepo();
  const good = root => stored(root, repo);
  const cases = [
    ['ref with a leading dash', r => ({ pfRepo: good(r), ref: '--upload-pack=x' })],
    ['ref with a leading dash in the lockfile', r => ({ pfRepo: good(r), lockRepo: good(r), lockRef: '-x' })],
    ['ref with whitespace', r => ({ pfRepo: good(r), ref: 'main branch' })],
    ['ref with a control character', r => ({ pfRepo: good(r), ref: 'main\u0007' })],
    ['ref git would refuse', r => ({ pfRepo: good(r), ref: 'a..b' })],
    ['ref ending in .lock', r => ({ pfRepo: good(r), ref: 'topic.lock' })],
    ['file:// scheme', () => ({ pfRepo: 'file:///etc' })],
    ['git:// scheme', () => ({ pfRepo: 'git://example.com/a/b.git' })],
    ['http:// scheme', () => ({ pfRepo: 'http://example.com/a/b.git' })],
    ['absolute local path', () => ({ pfRepo: repo.dir })],
    ['bare word', () => ({ pfRepo: 'agents' })],
    ['newline in the repo', () => ({ pfRepo: 'https://example.com/a/b\n--upload-pack=x' })],
    ['ssh host that is an option', () => ({ pfRepo: 'ssh://-oProxyCommand=x/a/b' })],
    ['scp-style host that is an option', () => ({ pfRepo: 'git@-oProxyCommand=x:a/b' })],
    ['remote helper inside a URL', () => ({ pfRepo: 'https::ext::sh' })],
  ];
  for (const [label, make] of cases) {
    const mark = marker();
    const root = await newProject();
    projectWith(root, make(root));
    await assertRefused(label, () => COMMANDS.sync(root), root, mark);
  }
});

test('an unsafe repo or ref typed on the command line is refused before git starts (project mode)', async () => {
  const repo = makeRepo();
  const base = { names: names({ agent: ['bug-finder'] }), all: false, targets: ['claude'], force: false, yes: true, allowExec: true };
  for (const [label, over] of [
    ['option-shaped repo', mark => ({ repoArg: injected(mark), ref: null })],
    ['ext:: repo', mark => ({ repoArg: extHelper(mark), ref: null })],
    ['git:// repo', () => ({ repoArg: 'git://example.com/a/b.git', ref: null })],
    ['option-shaped ref', () => ({ repoArg: repo.dir, ref: '--upload-pack=x' })],
    ['ref with a space', () => ({ repoArg: repo.dir, ref: 'a b' })],
  ]) {
    const mark = marker();
    const root = await newProject();
    await assertRefused(label, () => m.projectInstallCommand({ ...base, ...over(mark) }, ctx(root)), root, mark);
  }
});

test('global mode: the same inputs on the command line are refused before git starts', async () => {
  const repo = makeRepo();
  const { installCommand } = await import('../../src/commands/install.js');
  const args = { names: names({ agent: ['bug-finder'] }), all: false, targets: ['claude'], force: false, dryRun: false };
  for (const [label, over] of [
    ['option-shaped repo', mark => ({ repoArg: injected(mark), ref: null })],
    ['ext:: repo', mark => ({ repoArg: extHelper(mark), ref: null })],
    ['file:// repo', () => ({ repoArg: 'file:///etc', ref: null })],
    ['option-shaped ref', () => ({ repoArg: repo.dir, ref: '--upload-pack=x' })],
  ]) {
    const mark = marker();
    m.gitCalls.length = 0;
    await assert.rejects(() => installCommand({ ...args, ...over(mark) }), /not valid|not a valid|not allowed/i, label);
    assert.equal(m.gitCalls.length, 0, `${label}: a git process was started`);
    assert.ok(!exists(mark.dir, 'MARK'), `${label}: the injected command ran`);
  }
});

test('global mode through the real CLI, with git removed from PATH: validation comes first', () => {
  // With no git on PATH, morf can only report the invalid value if it checks
  // it before trying to start git. Otherwise it would say git is missing.
  const empty = tmp('morf-nogit-');
  const env = { ...process.env, PATH: empty, Path: empty, MORF_ASCII: '1' };
  const cwd = tmp();
  const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: 'utf8', env });

  for (const argv of [
    ['install', "ext::sh -c 'touch MARK'", '--agent', 'x', '--target', 'claude'],
    ['install', 'git://example.com/a/b', '--agent', 'x', '--target', 'claude'],
    ['install', 'https://example.com/a/b', '--agent', 'x', '--target', 'claude', '--ref', 'a..b'],
    ['update', '--all', '--ref', 'bad ref'],
  ]) {
    const res = cli(...argv);
    assert.equal(res.status, 1, argv.join(' '));
    assert.match(res.stdout + res.stderr, /not valid|not a valid|not allowed/i, argv.join(' '));
    assert.doesNotMatch(res.stdout + res.stderr, /git is required/, argv.join(' '));
  }
  assert.ok(!exists(cwd, 'MARK'));

  // A tampered install record: update must refuse that source, again before git.
  mkdirSync(join(m.home, '.morf'), { recursive: true });
  const recordPath = join(m.home, '.morf', 'installed.json');
  const saved = (() => { try { return readFileSync(recordPath, 'utf8'); } catch { return null; } })();
  writeFileSync(recordPath, JSON.stringify({ version: 3, items: { 'agent:x:claude': {
    type: 'agent', name: 'x', target: 'claude', project: '', repo: '--upload-pack=touch MARK;', repoKey: 'k', hash: 'h', ref: null,
  } } }));
  try {
    for (const argv of [['update', '--all'], ['list', '--check-updates']]) {
      const res = cli(...argv);
      assert.match(res.stdout + res.stderr, /not valid|not a valid|not allowed/i, argv.join(' '));
      assert.doesNotMatch(res.stdout + res.stderr, /git is required/, argv.join(' '));
    }
    assert.equal(cli('update', '--all').status, 1);
  } finally {
    if (saved === null) writeFileSync(recordPath, JSON.stringify({ version: 3, items: {} })); else writeFileSync(recordPath, saved);
  }
  assert.ok(!exists(cwd, 'MARK'));
});

test('a default repo or alias from the config file is validated like any other repo', async () => {
  const { resolveRepo } = await import('../../src/util/config.js');
  assert.throws(() => resolveRepo(null, { defaultRepo: '--upload-pack=x', aliases: {} }), /not valid|not allowed/i);
  assert.throws(() => resolveRepo('@evil', { aliases: { '@evil': "ext::sh -c 'id'" } }), /not valid|not allowed/i);
  assert.equal(resolveRepo('@ok', { aliases: { '@ok': 'https://github.com/acme/agents.git' } }), 'https://github.com/acme/agents.git');
});

test('every git invocation separates options from values and restricts transports', async () => {
  const repo = makeRepo();
  m.gitCalls.length = 0;
  const tip = await m.openClone(repo.dir, { ref: 'main' });
  await tip.close();
  const pinned = await m.openClone(repo.dir, { commit: repo.first });
  await pinned.close();
  const full = await m.openClone(repo.dir, { commit: repo.first, fullClone: true });
  await full.close();
  const { withTempClone } = await import('../../src/repo/git.js');
  await withTempClone(repo.dir, 'main', async () => {});

  assert.ok(m.gitCalls.length >= 6);
  for (const call of m.gitCalls) {
    assert.equal(call.allowProtocol, 'https:ssh:file', call.args.join(' '));
    // Any argument that carries a caller's value sits after an end-of-options marker.
    const values = call.args.map((a, i) => ({ a, i })).filter(x => x.a === repo.dir || x.a === repo.first);
    for (const { a, i } of values) {
      const guard = Math.max(call.args.lastIndexOf('--', i), call.args.lastIndexOf('--end-of-options', i));
      assert.ok(guard !== -1 && guard < i, `"${a}" is not protected in: git ${call.args.join(' ')}`);
    }
  }
  // A branch name is passed attached to its option, never as a separate word.
  assert.ok(m.gitCalls.some(c => c.args.includes('--branch=main')));
  assert.ok(!m.gitCalls.some(c => c.args.includes('--branch')));
});

// A real import of a module that can start a process or run a string as code.
// (convert/hooks.js has such an import only inside the text of the plugin it
// generates for OpenCode, which is not code morf itself runs.)
const SPAWNS = /^\s*import\s[^;]*['"](?:node:)?(?:child_process|worker_threads|vm)['"]|\brequire\(|\beval\(|new Function\(/m;

test('git is the only child process morf can start, and only from one module', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && SPAWNS.test(readFileSync(p, 'utf8'))) {
        offenders.push(p.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'));
      }
    }
  };
  walk(new URL('../../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.deepEqual(offenders, ['src/repo/git.js']);
});

test('validators: what is accepted and what is refused', () => {
  const okFile = ['https://github.com/acme/agents.git', 'https://gitlab.example.com:8443/group/sub/repo', 'ssh://git@github.com/acme/agents.git',
    'git@github.com:acme/agents.git', './local/repo', '../sibling', '..', '.'];
  for (const r of okFile) assert.doesNotThrow(() => m.assertSafeRepo(r), r);
  const bad = ['', '-x', '--upload-pack=x', 'ext::sh -c id', 'https::x', 'file:///x', 'git://h/x', 'http://h/x', 'ftp://h/x',
    '/abs/path', 'C:\\abs', 'agents', 'github.com/acme/agents', 'https://-h/x', 'ssh://-oProxyCommand=x/y', 'git@-o:x', '-u@h:p',
    'git@host:-path', 'https://h/x\n', 'https://h/x\u001b[2K', 'https://h/x y', 'host:path', 'https:///x', 42, null];
  for (const r of bad) assert.throws(() => m.assertSafeRepo(r), /not valid|not allowed/i, String(r));

  // On the command line an absolute local path and the host/owner/repo shorthand are fine too.
  for (const r of [...okFile, '/abs/path', 'C:\\abs\\repo', 'github.com/acme/agents', 'some-dir']) {
    assert.doesNotThrow(() => m.assertSafeRepo(r, { commandLine: true }), r);
  }
  for (const r of ['-x', 'ext::sh', 'git://h/x', 'http://h/x', 'a\nb', 'file:///x']) {
    assert.throws(() => m.assertSafeRepo(r, { commandLine: true }), /not valid|not allowed/i, r);
  }

  for (const r of ['main', 'v1.2.3', 'feature/lockfile', 'release-2026.11', 'a_b']) assert.doesNotThrow(() => m.assertSafeRef(r), r);
  for (const r of ['', '-x', '--upload-pack=x', 'a b', 'a\tb', 'a\u0000b', 'a..b', 'a.lock', 'x/y.lock/z', '.hidden', 'a/.b', 'a//b', 'a/',
    '/a', 'a.', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a@{1}', '@', 7]) {
    assert.throws(() => m.assertSafeRef(r), /not a valid/i, String(r));
  }
});

test('item names in the project files must be names the sanitizer accepts', async () => {
  const repo = makeRepo();
  for (const name of ['../../etc/passwd', '...', 'bad\u001bname', 'a\nb', '']) {
    const mark = marker();
    const root = await newProject();
    write(root, 'morf.json', JSON.stringify({ version: 1, sources: [{ repo: stored(root, repo), ref: 'main', targets: ['claude'],
      items: [{ type: 'agent', name }] }] }));
    await assertRefused(JSON.stringify(name), () => COMMANDS.sync(root), root, mark);
  }
});
