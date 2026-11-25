import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sandbox, tmp, cleanup, makeRepo, fakeIo, run, snapshot, read, readJson, write, exists, FIXTURE,
} from './helpers.js';

const m = await sandbox();
after(cleanup);

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const NAMES = () => ({ skill: [], agent: [], rule: [], prompt: [], hook: [], mcp: [] });
const names = (over) => ({ ...NAMES(), ...over });
const ctx = (root, io, morfVersion = '9.9.9') => ({ root, cwd: root, io: io || fakeIo(), morfVersion });

// A fresh project directory with an empty project file.
async function newProject() {
  const root = tmp('morf-proj-');
  await m.writeProjectFile(root, m.emptyProject());
  return root;
}

// Non-interactive install with both approval flags.
function install(root, repo, over = {}) {
  return run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: NAMES(), all: false, targets: ['claude'], force: false, ref: null,
    yes: true, allowExec: true, ...over,
  }, ctx(root)));
}

function sync(root, flags = {}, io = null, version) {
  return run(() => m.syncCommand({ yes: true, allowExec: true, ...flags }, ctx(root, io, version)));
}

// The repo as it is stored in the project files (relative to the project).
const stored = (root, repo) => m.cleanRepoForProject(repo.dir, root, root).stored;

// ── project files ─────────────────────────────────────────────────────────────

test('install writes the project file and lockfile, with no machine data', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const res = await install(root, repo, {
    names: names({ skill: ['pdf-skill'], agent: ['bug-finder'], rule: ['ts-style'], mcp: ['context7'] }),
    targets: ['claude', 'codex', 'cursor'],
  });
  assert.equal(res.code, 0, res.out);

  const pf = readJson(root, 'morf.json');
  assert.deepEqual(pf.sources[0].targets, ['claude', 'codex', 'cursor']);
  assert.deepEqual(pf.sources[0].items.map(i => `${i.type}:${i.name}`),
    ['agent:bug-finder', 'mcp:context7', 'rule:ts-style', 'skill:pdf-skill']);
  assert.equal(pf.sources[0].ref, 'main');

  const lock = readJson(root, 'morf.lock.json');
  assert.equal(lock.lockfileVersion, 1);
  assert.equal(lock.morfVersion, '9.9.9');
  assert.equal(lock.sources[0].commit, repo.first);
  for (const i of lock.sources[0].items) assert.match(i.hash, /^sha256:[0-9a-f]{64}$/);

  // Nothing machine-specific in either file.
  for (const file of ['morf.json', 'morf.lock.json']) {
    const text = read(root, file);
    assert.ok(!text.includes(m.home), `${file} contains the home directory`);
    assert.ok(!text.includes(root), `${file} contains the project path`);
    assert.ok(!/[A-Za-z]:\\\\|"\//.test(text), `${file} contains an absolute path`);
    assert.ok(text.endsWith('\n'));
  }

  // Everything landed inside the project, nothing in the home directory.
  for (const p of ['.claude/skills/pdf-skill/SKILL.md', '.claude/agents/bug-finder.md', '.claude/rules/ts-style.md',
    '.mcp.json', '.agents/skills/pdf-skill/sub/notes.txt', '.codex/agents/bug-finder.toml', 'AGENTS.md',
    '.codex/config.toml', '.cursor/agents/bug-finder.md', '.cursor/rules/ts-style.mdc', '.cursor/mcp.json']) {
    assert.ok(exists(root, p), `missing ${p}`);
  }
  assert.deepEqual(Object.keys(snapshot(m.home)).filter(k => !k.includes('.morf/')), []);
});

test('output is deterministic: a second run leaves both files byte-identical', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const args = { names: names({ agent: ['bug-finder'], rule: ['ts-style'] }), targets: ['cursor', 'claude'] };
  await install(root, repo, args);
  const before = [read(root, 'morf.json'), read(root, 'morf.lock.json')];
  await install(root, repo, args);
  await sync(root);
  assert.deepEqual([read(root, 'morf.json'), read(root, 'morf.lock.json')], before);

  // Order in, order out: lists are sorted whatever order they were given in.
  const other = await newProject();
  await m.writeProjectFile(other, { sources: [{ repo: 'https://b/x', ref: 'main', targets: ['cursor', 'claude'],
    items: [{ type: 'rule', name: 'z' }, { type: 'agent', name: 'a' }] }, { repo: 'https://a/x', ref: 'main',
    targets: ['claude'], items: [{ type: 'skill', name: 's' }] }] });
  const pf = readJson(other, 'morf.json');
  assert.deepEqual(pf.sources.map(s => s.repo), ['https://a/x', 'https://b/x']);
  assert.deepEqual(pf.sources[1].items.map(i => i.type), ['agent', 'rule']);
  assert.deepEqual(pf.sources[1].targets, ['claude', 'cursor']);
});

test('a resolved secret value is never written anywhere', async () => {
  const secret = 'morf-test-secret-7f3c9a4d';
  process.env.API_KEY = secret;
  try {
    const repo = makeRepo();
    const root = await newProject();
    const res = await install(root, repo, { names: names({ mcp: ['context7'] }), targets: ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'windsurf', 'copilot'] });
    assert.equal(res.code, 0, res.out);
    for (const dir of [root, m.home]) {
      for (const key of Object.keys(snapshot(dir))) {
        const rel = key.slice(key.indexOf(':', 3) + 1);
        assert.ok(!read(dir, rel).includes(secret), `${rel} contains the resolved secret`);
      }
    }
    assert.match(read(root, '.mcp.json'), /\$\{API_KEY\}/);
  } finally {
    delete process.env.API_KEY;
  }
});

test('credentials are stripped from repo URLs, or the URL is refused', () => {
  const root = tmp();
  const clean = u => m.cleanRepoForProject(u, root, root).stored;
  assert.equal(clean('https://user:ghp_token@github.com/acme/agents.git'), 'https://github.com/acme/agents.git');
  assert.equal(clean('https://ghp_token@github.com/acme/agents'), 'https://github.com/acme/agents');
  assert.equal(clean('ssh://git:pw@github.com/acme/agents.git'), 'ssh://git@github.com/acme/agents.git');
  assert.equal(clean('git@github.com:acme/agents.git'), 'git@github.com:acme/agents.git');
  assert.throws(() => clean('https://github.com/acme/agents.git?token=abc'), /cannot store it safely/);
  assert.throws(() => clean('user:pw@github.com:acme/agents.git'), /password/);
  // The error itself must not leak the credential.
  try { clean('https://user:supersecret@github.com/a/b?x=1'); } catch (e) { assert.ok(!e.message.includes('supersecret')); }
});

test('local repo paths are stored relative, with a warning', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const res = await install(root, repo, { names: names({ agent: ['bug-finder'] }) });
  const repoField = readJson(root, 'morf.json').sources[0].repo;
  assert.match(repoField, /^\.\.?\//);
  assert.ok(!repoField.includes('\\'));
  assert.match(res.out, /will not resolve on other machines/);
});

test('host/path shorthand expands to https only when no such local directory exists', () => {
  const dir = tmp();
  assert.equal(m.expandRepoShorthand('github.com/acme/agents', dir), 'https://github.com/acme/agents');
  mkdirSync(join(dir, 'github.com', 'acme', 'agents'), { recursive: true });
  assert.equal(m.expandRepoShorthand('github.com/acme/agents', dir), 'github.com/acme/agents');
  // Things that are not the shorthand are left alone.
  for (const s of ['./local/repo/x', '../a/b/c', 'git@github.com:a/b.git', 'https://github.com/a/b', 'acme/agents', 'C:\\repos\\a\\b']) {
    assert.equal(m.expandRepoShorthand(s, dir), s);
  }
});

test('a lockfile from a newer morf is rejected without being read', async () => {
  const root = await newProject();
  write(root, 'morf.lock.json', JSON.stringify({ lockfileVersion: 2, sources: 'not even the right shape' }));
  const before = snapshot(root);
  const res = await sync(root);
  assert.equal(res.code, 1);
  assert.match(res.out, /Upgrade morf/);
  assert.deepEqual(snapshot(root), before);
});

test('morfVersion alone never rewrites the lockfile', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'] }) });
  const before = read(root, 'morf.lock.json');
  const res = await sync(root, {}, null, '0.0.1-other');
  assert.equal(res.code, 0, res.out);
  assert.equal(read(root, 'morf.lock.json'), before);
});

test('portable hash: same commit, same hash with LF or CRLF checkouts and either path separator', async () => {
  const d1 = m.portableDigest([{ rel: 'a/b.txt', buf: Buffer.from('x') }, { rel: 'a.txt', buf: Buffer.from('y') }]);
  const d2 = m.portableDigest([{ rel: 'a.txt', buf: Buffer.from('y') }, { rel: 'a\\b.txt', buf: Buffer.from('x') }]);
  assert.equal(d1, d2);

  // The same commit fetched under core.autocrlf=true and =false.
  const repo = makeRepo({ ...FIXTURE, 'skills/pdf-skill/crlf.txt': 'one\r\ntwo\r\n' });
  const hashes = [];
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    for (const value of ['true', 'false']) {
      const cfg = join(tmp(), 'gitconfig');
      writeFileSync(cfg, `[core]\n\tautocrlf = ${value}\n`);
      process.env.GIT_CONFIG_GLOBAL = cfg;
      const clone = await m.openClone(repo.dir, { commit: repo.first });
      try {
        hashes.push(await m.portableHashPath(join(clone.dir, 'skills', 'pdf-skill')));
        assert.equal(read(clone.dir, 'skills/pdf-skill/SKILL.md'), FIXTURE['skills/pdf-skill/SKILL.md']);
        assert.equal(read(clone.dir, 'skills/pdf-skill/crlf.txt'), 'one\r\ntwo\r\n');
      } finally {
        await clone.close();
      }
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
  }
  assert.equal(hashes[0], hashes[1]);
});

// ── project detection and scope ───────────────────────────────────────────────

test('the project is found from a subdirectory', async () => {
  const root = await newProject();
  const sub = join(root, 'packages', 'app', 'src');
  mkdirSync(sub, { recursive: true });
  assert.equal(m.findProjectRoot(sub), root);
  assert.equal(m.findProjectRoot(tmp()), null);

  // And through the real CLI.
  const out = spawnSync(process.execPath, [CLI, 'sync', '--check'], { cwd: sub, encoding: 'utf8', env: { ...process.env } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /No drift/);
});

test('morf init creates an empty project file and refuses to overwrite one', async () => {
  const dir = tmp();
  assert.equal((await run(() => m.initCommand({ cwd: dir }))).code, 0);
  assert.deepEqual(readJson(dir, 'morf.json'), { sources: [], version: 1 });
  const again = await run(() => m.initCommand({ cwd: dir }));
  assert.equal(again.code, 1);
  assert.match(again.out, /already exists/);
});

test('--global inside a project leaves the project files alone; both installs coexist', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const env = { ...process.env, MORF_ASCII: '1' };
  const before = snapshot(root);

  const g = spawnSync(process.execPath, [CLI, 'install', repo.dir, '--global', '--skill', 'pdf-skill', '--target', 'claude'],
    { cwd: root, encoding: 'utf8', env });
  assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.deepEqual(snapshot(root), before);
  assert.ok(exists(m.home, '.claude/skills/pdf-skill/SKILL.md'));

  // The same item installed into the project is a separate record.
  const p = spawnSync(process.execPath, [CLI, 'install', repo.dir, '--skill', 'pdf-skill', '--target', 'claude', '--yes'],
    { cwd: root, encoding: 'utf8', env });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.ok(exists(root, '.claude/skills/pdf-skill/SKILL.md'));
  const items = Object.values(readJson(m.home, '.morf/installed.json').items)
    .filter(r => r.type === 'skill' && r.name === 'pdf-skill' && r.target === 'claude' && ['', root].includes(r.project));
  assert.deepEqual(items.map(r => r.project).sort(), ['', root].sort());

  // Removing the project one leaves the global one in place, and vice versa.
  const u = spawnSync(process.execPath, [CLI, 'uninstall', '--skill', 'pdf-skill', '--yes'], { cwd: root, encoding: 'utf8', env });
  assert.equal(u.status, 0, u.stdout + u.stderr);
  assert.ok(!exists(root, '.claude/skills/pdf-skill'));
  assert.ok(exists(m.home, '.claude/skills/pdf-skill/SKILL.md'));
  const gu = spawnSync(process.execPath, [CLI, 'uninstall', '--global', '--skill', 'pdf-skill', '-y'], { cwd: root, encoding: 'utf8', env });
  assert.equal(gu.status, 0, gu.stdout + gu.stderr);
  assert.ok(!exists(m.home, '.claude/skills/pdf-skill'));
});

test('old install records migrate: they become global installs, keys unchanged', () => {
  const v2 = { version: 2, items: {
    'agent:x:claude': { type: 'agent', name: 'x', target: 'claude', hash: 'h', repo: 'r' },
    'skill:y:cursor': { type: 'skill', name: 'y', target: 'cursor', hash: 'h2', repo: 'r' },
  } };
  const { manifest, migrated } = m.upgradeManifest(v2);
  assert.equal(migrated, true);
  assert.equal(manifest.version, 3);
  assert.deepEqual(Object.keys(manifest.items).sort(), ['agent:x:claude', 'skill:y:cursor']);
  for (const r of Object.values(manifest.items)) assert.equal(r.project, '');
  assert.equal(m.getRecord(manifest, 'agent', 'x', 'claude').hash, 'h');

  const v1 = m.upgradeManifest({ version: 1, items: { 'agent:z': { type: 'agent', name: 'z', hash: 'h' } } });
  assert.equal(v1.manifest.items['agent:z:claude'].project, '');
  assert.equal(m.upgradeManifest(manifest).migrated, false);

  // A project record and a global record for the same item have different keys.
  assert.notEqual(m.manifestKey('agent', 'x', 'claude', '/work/shop'), m.manifestKey('agent', 'x', 'claude'));
});

// ── sync: one test per row of the table ───────────────────────────────────────

// A project whose morf.json was written by hand (no lockfile, nothing installed).
async function handWritten(repo, items, targets = ['claude']) {
  const root = tmp('morf-proj-');
  await m.writeProjectFile(root, { sources: [{ repo: stored(root, repo), ref: 'main', targets, items }] });
  return root;
}

test('row: project file exists, no lockfile', async () => {
  const repo = makeRepo();
  const item = [{ type: 'agent', name: 'bug-finder' }];

  const frozenRoot = await handWritten(repo, item);
  const before = snapshot(frozenRoot);
  const frozen = await sync(frozenRoot, { frozen: true });
  assert.equal(frozen.code, 1);
  assert.deepEqual(snapshot(frozenRoot), before);

  const root = await handWritten(repo, item);
  const res = await sync(root);
  assert.equal(res.code, 0, res.out);
  assert.equal(readJson(root, 'morf.lock.json').sources[0].commit, repo.first);
  assert.ok(exists(root, '.claude/agents/bug-finder.md'));
});

test('row: project file has entries the lockfile lacks — only those are resolved', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'] }) });
  repo.commit({ 'agents/bug-finder.md': 'changed upstream\n' });

  const pf = readJson(root, 'morf.json');
  pf.sources[0].items.push({ type: 'rule', name: 'ts-style' });
  write(root, 'morf.json', JSON.stringify(pf));

  const before = snapshot(root);
  const frozen = await sync(root, { frozen: true });
  assert.equal(frozen.code, 1);
  assert.deepEqual(snapshot(root), before);

  const agentBefore = read(root, '.claude/agents/bug-finder.md');
  const res = await sync(root);
  assert.equal(res.code, 0, res.out);
  const lock = readJson(root, 'morf.lock.json');
  assert.equal(lock.sources[0].commit, repo.first, 'existing entries stay pinned');
  assert.deepEqual(lock.sources[0].items.map(i => i.name), ['bug-finder', 'ts-style']);
  assert.ok(exists(root, '.claude/rules/ts-style.md'));
  assert.equal(read(root, '.claude/agents/bug-finder.md'), agentBefore);
});

test('row: lockfile has entries the project file lacks — pruned only with consent', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'], rule: ['ts-style'] }) });
  const pf = readJson(root, 'morf.json');
  pf.sources[0].items = pf.sources[0].items.filter(i => i.type !== 'rule');
  write(root, 'morf.json', JSON.stringify(pf));

  const before = snapshot(root);
  const frozen = await sync(root, { frozen: true });
  assert.equal(frozen.code, 1);
  assert.deepEqual(snapshot(root), before);

  // Listed in the plan, but not removed without --prune or a yes.
  const listed = await sync(root);
  assert.equal(listed.code, 0, listed.out);
  assert.match(listed.out, /prune\s+rule\s+ts-style/);
  assert.ok(exists(root, '.claude/rules/ts-style.md'));
  assert.ok(readJson(root, 'morf.lock.json').sources[0].items.some(i => i.name === 'ts-style'));

  // An interactive "no" to the prune question keeps it too.
  const declined = await sync(root, { yes: false, allowExec: false }, fakeIo({ tty: true, answers: ['n'] }));
  assert.equal(declined.code, 0, declined.out);
  assert.ok(exists(root, '.claude/rules/ts-style.md'));

  const pruned = await sync(root, { prune: true });
  assert.equal(pruned.code, 0, pruned.out);
  assert.ok(!exists(root, '.claude/rules/ts-style.md'));
  assert.ok(!readJson(root, 'morf.lock.json').sources[0].items.some(i => i.name === 'ts-style'));
  assert.ok(exists(root, '.claude/agents/bug-finder.md'));
});

test('row: neither file found', async () => {
  const dir = tmp();
  for (const flags of [{}, { frozen: true }]) {
    const res = await sync(dir, flags);
    assert.equal(res.code, 1);
    assert.match(res.out, /morf init/);
  }
  assert.deepEqual(snapshot(dir), {});
});

test('row: item installed and matching — nothing happens, no flags needed', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'], mcp: ['context7'] }) });
  const before = snapshot(root);
  for (const flags of [{ yes: false, allowExec: false }, { yes: false, allowExec: false, frozen: true }]) {
    const res = await sync(root, flags);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /Nothing to do/);
    assert.deepEqual(snapshot(root), before);
  }
});

// A project installed at the first commit, plus the lockfile for the second.
async function twoVersions() {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'] }) });
  const lockA = read(root, 'morf.lock.json');
  const second = repo.commit({ 'agents/bug-finder.md': '---\nname: bug-finder\ndescription: v2\n---\nSecond version.\n' });
  const up = await run(() => m.syncCommand({ update: true, yes: true, allowExec: true }, ctx(root)));
  assert.equal(up.code, 0, up.out);
  assert.equal(readJson(root, 'morf.lock.json').sources[0].commit, second);
  assert.match(read(root, '.claude/agents/bug-finder.md'), /Second version/);
  return { repo, root, lockA, second };
}

test('row: item differs and was not edited locally — replaced (also with --frozen)', async () => {
  for (const frozen of [false, true]) {
    const { root, lockA } = await twoVersions();
    write(root, 'morf.lock.json', lockA);       // e.g. a teammate's lockfile arrives via git
    const res = await sync(root, { frozen });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /replace\s+agent\s+bug-finder/);
    assert.match(read(root, '.claude/agents/bug-finder.md'), /Find bugs\./);
    assert.equal(read(root, 'morf.lock.json'), lockA);
  }
});

test('row: item edited locally — skipped with a warning; --frozen fails; --force overwrites', async () => {
  const { root, lockA } = await twoVersions();
  write(root, 'morf.lock.json', lockA);
  write(root, '.claude/agents/bug-finder.md', 'my own edits\n');

  const frozen = await sync(root, { frozen: true });
  assert.equal(frozen.code, 1);
  assert.equal(read(root, '.claude/agents/bug-finder.md'), 'my own edits\n');

  const res = await sync(root);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /skip\s+agent\s+bug-finder\s+edited locally/);
  assert.match(res.out, /skipped because of local edits/);
  assert.equal(read(root, '.claude/agents/bug-finder.md'), 'my own edits\n');

  for (const flags of [{ force: true }, { force: true, frozen: true }]) {
    write(root, '.claude/agents/bug-finder.md', 'my own edits\n');
    const forced = await sync(root, flags);
    assert.equal(forced.code, 0, forced.out);
    assert.match(read(root, '.claude/agents/bug-finder.md'), /Find bugs\./);
  }
});

test('row: the recorded commit cannot be fetched — exit 1, nothing installed', async () => {
  const repo = makeRepo();
  for (const frozen of [false, true]) {
    const root = await handWritten(repo, [{ type: 'agent', name: 'bug-finder' }]);
    await m.writeLockfile(root, { sources: [{ repo: stored(root, repo), ref: 'main', commit: 'd'.repeat(40),
      items: [{ type: 'agent', name: 'bug-finder', hash: 'sha256:' + '0'.repeat(64) }] }] }, '9.9.9');
    const before = snapshot(root);
    const res = await sync(root, { frozen });
    assert.equal(res.code, 1);
    assert.match(res.out, /could not be fetched/);
    assert.deepEqual(snapshot(root), before);
  }
});

test('row: content hash differs from the lockfile after fetch — exit 1, names the item', async () => {
  const repo = makeRepo();
  for (const frozen of [false, true]) {
    const root = await handWritten(repo, [{ type: 'agent', name: 'bug-finder' }, { type: 'rule', name: 'ts-style' }]);
    const good = await sync(root);
    assert.equal(good.code, 0, good.out);
    const lock = readJson(root, 'morf.lock.json');
    lock.sources[0].items.find(i => i.name === 'ts-style').hash = 'sha256:' + 'a'.repeat(64);
    write(root, 'morf.lock.json', JSON.stringify(lock, null, 2) + '\n');
    write(root, '.claude/agents/bug-finder.md', 'x');   // would otherwise be touched
    const before = snapshot(root);
    const res = await sync(root, { frozen, force: true });
    assert.equal(res.code, 1);
    assert.match(res.out, /rule 'ts-style'.*does not match the lockfile/);
    assert.deepEqual(snapshot(root), before);
  }
});

test('row: a target tool that is not installed on this machine still gets its project files', async () => {
  const repo = makeRepo();
  assert.ok(!exists(m.home, '.kilo') && !exists(m.home, '.config/kilo'));
  for (const frozen of [false, true]) {
    const root = await handWritten(repo, [{ type: 'agent', name: 'bug-finder' }, { type: 'rule', name: 'ts-style' }], ['kilo', 'opencode']);
    await sync(root);                                     // creates the lockfile
    await run(() => m.projectUninstallCommand({ names: NAMES(), all: true, targets: [], yes: true, allowExec: true }, ctx(root)));
    await m.writeProjectFile(root, { sources: [{ repo: stored(root, repo), ref: 'main', targets: ['kilo', 'opencode'],
      items: [{ type: 'agent', name: 'bug-finder' }, { type: 'rule', name: 'ts-style' }] }] });
    const lockSrc = { repo: stored(root, repo), ref: 'main', commit: repo.first, items: [] };
    for (const [type, name, path] of [['agent', 'bug-finder', 'agents/bug-finder.md'], ['rule', 'ts-style', 'rules/ts-style.md']]) {
      lockSrc.items.push({ type, name, hash: await m.portableHashPath(join(repo.dir, path)) });
    }
    await m.writeLockfile(root, { sources: [lockSrc] }, '9.9.9');
    const res = await sync(root, { frozen });
    assert.equal(res.code, 0, res.out);
    assert.ok(exists(root, '.kilo/agents/bug-finder.md'));
    assert.ok(exists(root, '.opencode/rules/ts-style.md'));
    // The registered rule path is relative, never absolute.
    assert.deepEqual(readJson(root, 'opencode.json').instructions, ['.opencode/rules/ts-style.md']);
    assert.deepEqual(readJson(root, 'kilo.jsonc').instructions, ['.kilo/rules/ts-style.md']);
  }
});

test('codex prompts are shown as unsupported, and are neither drift nor a --frozen failure', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const res = await install(root, repo, { names: names({ prompt: ['fix-issue'] }), targets: ['codex', 'claude'] });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /unsupported\s+prompt\s+fix-issue\s+unsupported \(codex has no project-level prompts\)/);
  assert.ok(exists(root, '.claude/commands/fix-issue.md'));
  assert.equal((await sync(root, { frozen: true, yes: false, allowExec: false })).code, 0);
  const check = await sync(root, { check: true, yes: false, allowExec: false });
  assert.equal(check.code, 0, check.out);
});

test('a rule for codex plus a tool that reads AGENTS.md warns that it applies twice', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const res = await install(root, repo, { names: names({ rule: ['ts-style'] }), targets: ['codex', 'cursor', 'claude'] });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /rule 'ts-style' is written to AGENTS\.md for codex, and cursor also reads AGENTS\.md/);
  assert.match(read(root, 'AGENTS.md'), /<!-- morf:rule:ts-style -->[\s\S]*<!-- \/morf:rule:ts-style -->/);
});

// ── approval ──────────────────────────────────────────────────────────────────

const WITH_EXEC = [{ type: 'agent', name: 'bug-finder' }, { type: 'mcp', name: 'context7' }, { type: 'hook', name: 'guard' }];

test('interactive: plan declined — nothing changes, exit 1', async () => {
  const repo = makeRepo();
  const root = await handWritten(repo, WITH_EXEC);
  const before = snapshot(root, m.home);
  const io = fakeIo({ tty: true, answers: ['n'] });
  const res = await sync(root, { yes: false, allowExec: false }, io);
  assert.equal(res.code, 1);
  assert.equal(io.asked.length, 1);
  assert.match(io.asked[0], /Apply these changes\? \[y\/N\]/);
  assert.deepEqual(snapshot(root, m.home), before);

  // The default (just pressing Enter) is No.
  const enter = await sync(root, { yes: false, allowExec: false }, fakeIo({ tty: true, answers: [''] }));
  assert.equal(enter.code, 1);
  assert.deepEqual(snapshot(root, m.home), before);
});

test('interactive: plan accepted, hooks/MCP question declined — nothing changes, exit 1', async () => {
  const repo = makeRepo();
  const root = await handWritten(repo, WITH_EXEC);
  const before = snapshot(root, m.home);
  const io = fakeIo({ tty: true, answers: ['y', 'n'] });
  const res = await sync(root, { yes: false, allowExec: false }, io);
  assert.equal(res.code, 1);
  assert.equal(io.asked.length, 2);
  assert.match(io.asked[1], /hooks and MCP servers/);
  assert.match(res.out, /npx -y ctx7/);
  assert.match(res.out, /\.\/check\.sh/);
  assert.deepEqual(snapshot(root, m.home), before, 'not even the agent is installed');

  const both = await sync(root, { yes: false, allowExec: false }, fakeIo({ tty: true, answers: ['y', 'y'] }));
  assert.equal(both.code, 0, both.out);
  assert.ok(exists(root, '.claude/agents/bug-finder.md') && exists(root, '.mcp.json') && exists(root, '.claude/settings.json'));
});

test('CI without --yes — plan printed, nothing changes, exit 1', async () => {
  const repo = makeRepo();
  const root = await handWritten(repo, [{ type: 'agent', name: 'bug-finder' }]);
  await sync(root);                                   // lockfile exists, as it would in CI
  await run(() => m.projectUninstallCommand({ names: NAMES(), all: true, targets: [], yes: true }, ctx(root)));
  await m.writeProjectFile(root, { sources: [{ repo: stored(root, repo), ref: 'main', targets: ['claude'], items: [{ type: 'agent', name: 'bug-finder' }] }] });
  await sync(root, { check: true }).then(() => null);
  write(root, 'morf.lock.json', JSON.stringify({ lockfileVersion: 1, sources: [{ repo: stored(root, repo), ref: 'main',
    commit: repo.first, items: [{ type: 'agent', name: 'bug-finder', hash: await m.portableHashPath(join(repo.dir, 'agents/bug-finder.md')) }] }] }));
  const before = snapshot(root, m.home);
  for (const io of [fakeIo({ env: { CI: 'true' } }), fakeIo({ tty: true, env: { CI: '1' } }), fakeIo({ tty: false })]) {
    const res = await sync(root, { yes: false, allowExec: false }, io);
    assert.equal(res.code, 1);
    assert.equal(io.asked.length, 0, 'never asks');
    assert.match(res.out, /install\s+agent\s+bug-finder/);
    assert.match(res.out, /Re-run with --yes/);
    assert.deepEqual(snapshot(root, m.home), before);
  }
});

test('CI with --yes but no --allow-exec, plan has a hook or MCP server — nothing changes, exit 1', async () => {
  const repo = makeRepo();
  for (const items of [WITH_EXEC, [WITH_EXEC[0], WITH_EXEC[1]], [WITH_EXEC[0], WITH_EXEC[2]]]) {
    const root = await handWritten(repo, items);
    const before = snapshot(root, m.home);
    const io = fakeIo({ tty: false });
    const res = await sync(root, { yes: true, allowExec: false }, io);
    assert.equal(res.code, 1);
    assert.equal(io.asked.length, 0);
    assert.match(res.out, /--yes --allow-exec/);
    assert.deepEqual(snapshot(root, m.home), before, 'the agent must not be installed either');
  }
});

test('CI with --yes and --allow-exec — everything installs', async () => {
  const repo = makeRepo();
  const root = await handWritten(repo, WITH_EXEC);
  await sync(root);
  // Start again from the committed files only, as a CI checkout would.
  const lock = read(root, 'morf.lock.json');
  const pf = read(root, 'morf.json');
  await run(() => m.projectUninstallCommand({ names: NAMES(), all: true, targets: [], yes: true, allowExec: true }, ctx(root)));
  write(root, 'morf.json', pf);
  write(root, 'morf.lock.json', lock);

  const io = fakeIo({ env: { CI: 'true' } });
  const res = await sync(root, { yes: true, allowExec: true }, io);
  assert.equal(res.code, 0, res.out);
  assert.equal(io.asked.length, 0);
  assert.ok(exists(root, '.claude/agents/bug-finder.md'));
  assert.ok(readJson(root, '.mcp.json').mcpServers.context7);
  assert.ok(readJson(root, '.claude/settings.json').hooks.PreToolUse.length === 1);
  assert.equal(read(root, 'morf.lock.json'), lock, '--frozen (the CI default) never rewrites the lockfile');
});

test('--yes and --allow-exec are never read from config, project file, lockfile or environment', async () => {
  const repo = makeRepo();
  const root = await handWritten(repo, WITH_EXEC);
  const pf = readJson(root, 'morf.json');
  Object.assign(pf, { yes: true, allowExec: true, 'allow-exec': true, approve: true });
  write(root, 'morf.json', JSON.stringify(pf));
  write(m.home, '.morf/config.json', JSON.stringify({ yes: true, allowExec: true, 'allow-exec': true, defaultTarget: null, aliases: {} }));
  const env = { MORF_YES: '1', MORF_ALLOW_EXEC: '1', YES: '1', ALLOW_EXEC: '1', npm_config_yes: 'true' };
  Object.assign(process.env, env);
  try {
    const before = snapshot(root);
    const none = await sync(root, { yes: false, allowExec: false }, fakeIo({ tty: false, env }));
    assert.equal(none.code, 1);
    assert.deepEqual(snapshot(root), before);
    const onlyYes = await sync(root, { yes: true, allowExec: false }, fakeIo({ tty: false, env }));
    assert.equal(onlyYes.code, 1);
    assert.deepEqual(snapshot(root), before);

    // Same through the real CLI, where the flags could only come from argv.
    const cli = spawnSync(process.execPath, [CLI, 'sync'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    assert.deepEqual(snapshot(root), before);

    // A lockfile carrying the flags does not grant them either.
    const ok = await sync(root);
    assert.equal(ok.code, 0, ok.out);
    const lock = readJson(root, 'morf.lock.json');
    Object.assign(lock, { yes: true, allowExec: true });
    await run(() => m.projectUninstallCommand({ names: NAMES(), all: true, targets: [], yes: true, allowExec: true }, ctx(root)));
    write(root, 'morf.json', JSON.stringify(pf));
    write(root, 'morf.lock.json', JSON.stringify(lock));
    const snap = snapshot(root);
    const res = await sync(root, { yes: false, allowExec: false }, fakeIo({ tty: false, env }));
    assert.equal(res.code, 1);
    assert.deepEqual(snapshot(root), snap);
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    write(m.home, '.morf/config.json', '{}');
  }
});

test('--check never changes anything, needs no flags, and reports both kinds of drift', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'], rule: ['ts-style'], mcp: ['context7'] }) });

  const clean = snapshot(root, m.home);
  const ok = await sync(root, { check: true, yes: false, allowExec: false }, fakeIo({ env: { CI: '1' } }));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /No drift/);
  assert.deepEqual(snapshot(root, m.home), clean);

  // Disk drift: one item edited, one deleted. Declaration drift: one new entry.
  write(root, '.claude/agents/bug-finder.md', 'edited\n');
  const pf = readJson(root, 'morf.json');
  pf.sources[0].items.push({ type: 'skill', name: 'pdf-skill' });
  write(root, 'morf.json', JSON.stringify(pf));
  const lock = readJson(root, 'morf.lock.json');
  lock.sources[0].items.push({ type: 'prompt', name: 'gone', hash: 'sha256:' + '1'.repeat(64) });
  write(root, 'morf.lock.json', JSON.stringify(lock));

  const drifted = snapshot(root, m.home);
  const res = await sync(root, { check: true, yes: false, allowExec: false });
  assert.equal(res.code, 1);
  assert.match(res.out, /Drift: project file vs lockfile/);
  assert.match(res.out, /skill 'pdf-skill'.*in the project file but not in the lockfile/);
  assert.match(res.out, /prompt 'gone'.*in the lockfile but not in the project file/);
  assert.match(res.out, /Drift: lockfile vs what is on disk/);
  assert.match(res.out, /agent 'bug-finder' was edited locally/);
  assert.deepEqual(snapshot(root, m.home), drifted);
});

test('install and uninstall in a project also go through approval', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const before = snapshot(root, m.home);
  const args = { repoArg: repo.dir, names: names({ agent: ['bug-finder'], mcp: ['context7'] }), all: false, targets: ['claude'], force: false, ref: null };

  const noYes = await run(() => m.projectInstallCommand({ ...args, yes: false, allowExec: false }, ctx(root)));
  assert.equal(noYes.code, 1);
  const noExec = await run(() => m.projectInstallCommand({ ...args, yes: true, allowExec: false }, ctx(root)));
  assert.equal(noExec.code, 1);
  const declined = await run(() => m.projectInstallCommand({ ...args, yes: false, allowExec: false }, ctx(root, fakeIo({ tty: true, answers: ['y', 'n'] }))));
  assert.equal(declined.code, 1);
  assert.deepEqual(snapshot(root, m.home), before);

  assert.equal((await install(root, repo, { names: args.names })).code, 0);
  const installed = snapshot(root, m.home);
  const un = { names: names({ agent: ['bug-finder'], mcp: ['context7'] }), all: false, targets: [] };
  assert.equal((await run(() => m.projectUninstallCommand({ ...un, yes: false, allowExec: false }, ctx(root)))).code, 1);
  assert.deepEqual(snapshot(root, m.home), installed);
  // Interactive: one question only — removing an MCP server asks nothing extra.
  const io = fakeIo({ tty: true, answers: ['n'] });
  assert.equal((await run(() => m.projectUninstallCommand({ ...un, yes: false, allowExec: false }, ctx(root, io)))).code, 1);
  assert.equal(io.asked.length, 1);
  assert.deepEqual(snapshot(root, m.home), installed);
  // Non-interactive: --yes is enough. Removal runs no code, so no --allow-exec.
  const removed = await run(() => m.projectUninstallCommand({ ...un, yes: true, allowExec: false }, ctx(root)));
  assert.equal(removed.code, 0, removed.out);
  assert.ok(!removed.out.includes('--allow-exec'));
  assert.ok(!exists(root, '.claude/agents/bug-finder.md'));
  assert.equal(readJson(root, '.mcp.json').mcpServers.context7, undefined);
  assert.deepEqual(readJson(root, 'morf.json').sources, []);
  assert.deepEqual(readJson(root, 'morf.lock.json').sources, []);
});

test('pruning a hook or MCP server needs --yes and --prune, never --allow-exec', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'], mcp: ['context7'], hook: ['guard'] }) });
  const pf = readJson(root, 'morf.json');
  pf.sources[0].items = pf.sources[0].items.filter(i => i.type === 'agent');
  write(root, 'morf.json', JSON.stringify(pf));

  const before = snapshot(root);
  // --prune without --yes: nothing happens.
  assert.equal((await sync(root, { yes: false, allowExec: false, prune: true })).code, 1);
  assert.deepEqual(snapshot(root), before);

  const res = await sync(root, { yes: true, allowExec: false, prune: true });
  assert.equal(res.code, 0, res.out);
  assert.equal(readJson(root, '.mcp.json').mcpServers.context7, undefined);
  assert.equal(readJson(root, '.claude/settings.json').hooks.PreToolUse, undefined);
  assert.ok(exists(root, '.claude/agents/bug-finder.md'));
});

// ── --dry-run ─────────────────────────────────────────────────────────────────

test('--dry-run prints the plan, asks nothing, changes nothing and exits 0 — whatever the other flags', async () => {
  const repo = makeRepo();
  const combos = [
    {}, { yes: true, allowExec: true }, { yes: true, allowExec: true, force: true, prune: true },
  ];

  // sync, on a project with something to install, something edited and something to prune.
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'], rule: ['ts-style'] }) });
  const pf = readJson(root, 'morf.json');
  pf.sources[0].items = [{ type: 'agent', name: 'bug-finder' }, ...WITH_EXEC.slice(1)];
  write(root, 'morf.json', JSON.stringify(pf));
  write(root, '.claude/agents/bug-finder.md', 'edited\n');

  for (const flags of combos) {
    for (const io of [fakeIo({ tty: true, answers: ['y', 'y', 'y'] }), fakeIo({ tty: false })]) {
      const before = snapshot(root, m.home);
      const res = await sync(root, { yes: false, allowExec: false, ...flags, dryRun: true }, io);
      assert.equal(res.code, 0, res.out);
      assert.equal(io.asked.length, 0, 'never asks');
      assert.match(res.out, /install\s+mcp\s+context7/);
      assert.match(res.out, /prune\s+rule\s+ts-style/);
      assert.match(res.out, /Nothing was changed/);
      assert.deepEqual(snapshot(root, m.home), before);
    }
  }

  // install and uninstall.
  const other = await newProject();
  await install(other, repo, { names: names({ agent: ['bug-finder'] }) });
  for (const flags of combos) {
    const io = fakeIo({ tty: true, answers: ['y', 'y'] });
    const before = snapshot(other, m.home);
    const ins = await run(() => m.projectInstallCommand({
      repoArg: repo.dir, names: names({ mcp: ['context7'], hook: ['guard'] }), all: false, targets: ['claude', 'cursor'],
      ref: null, yes: false, allowExec: false, force: false, ...flags, dryRun: true,
    }, ctx(other, io)));
    assert.equal(ins.code, 0, ins.out);
    const un = await run(() => m.projectUninstallCommand({
      names: NAMES(), all: true, targets: [], yes: false, allowExec: false, ...flags, dryRun: true,
    }, ctx(other, io)));
    assert.equal(un.code, 0, un.out);
    assert.match(un.out, /remove\s+agent\s+bug-finder/);
    assert.equal(io.asked.length, 0);
    assert.deepEqual(snapshot(other, m.home), before);
  }

  // And through the real CLI.
  const before = snapshot(root, m.home);
  const cli = spawnSync(process.execPath, [CLI, 'sync', '--dry-run', '--yes', '--allow-exec', '--prune', '--force'],
    { cwd: root, encoding: 'utf8', env: { ...process.env } });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /Nothing was changed/);
  assert.deepEqual(snapshot(root, m.home), before);
});

// ── shared ownership ──────────────────────────────────────────────────────────

const uninstall = (root, over) => run(() => m.projectUninstallCommand(
  { names: NAMES(), all: false, targets: [], yes: true, allowExec: true, ...over }, ctx(root)));

test('shared item, two owners: uninstalling one keeps it, uninstalling both removes it', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const res = await install(root, repo, { names: names({ skill: ['pdf-skill'], mcp: ['context7'] }), targets: ['codex', 'copilot', 'claude'] });
  assert.equal(res.code, 0, res.out);
  assert.ok(exists(root, '.agents/skills/pdf-skill/SKILL.md'));
  // One shared .mcp.json entry for Claude Code and Copilot, in the shape both read.
  assert.deepEqual(readJson(root, '.mcp.json').mcpServers.context7,
    { type: 'stdio', command: 'npx', args: ['-y', 'ctx7'], env: { API_KEY: '${API_KEY}' }, tools: ['*'] });
  // A second sync sees no local edits on the shared items.
  assert.match((await sync(root, { yes: false, allowExec: false })).out, /Nothing to do/);

  await uninstall(root, { names: names({ skill: ['pdf-skill'], mcp: ['context7'] }), targets: ['codex', 'claude'] });
  assert.ok(exists(root, '.agents/skills/pdf-skill/SKILL.md'), 'copilot still owns the skill');
  assert.ok(readJson(root, '.mcp.json').mcpServers.context7, 'copilot still owns the MCP entry');
  assert.ok(!exists(root, '.claude/skills/pdf-skill'));
  assert.deepEqual(readJson(root, 'morf.json').sources[0].targets, ['copilot']);

  await uninstall(root, { names: names({ skill: ['pdf-skill'], mcp: ['context7'] }), targets: ['copilot'] });
  assert.ok(!exists(root, '.agents/skills/pdf-skill'));
  assert.equal(readJson(root, '.mcp.json').mcpServers.context7, undefined);
});

test('shared item: sync after one owner is removed from the project file', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ skill: ['pdf-skill'] }), targets: ['codex', 'copilot'] });
  const pf = readJson(root, 'morf.json');
  pf.sources[0].targets = ['copilot'];
  write(root, 'morf.json', JSON.stringify(pf));

  const res = await sync(root, { prune: true });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /prune\s+skill\s+pdf-skill/);
  assert.ok(exists(root, '.agents/skills/pdf-skill/SKILL.md'), 'still owned by copilot');
  const owners = Object.values(readJson(m.home, '.morf/installed.json').items)
    .filter(r => r.project === root && r.name === 'pdf-skill').map(r => r.target);
  assert.deepEqual(owners, ['copilot']);
  assert.match((await sync(root, { check: true })).out, /No drift/);
});

test('tool files committed to the repository are recognised on a fresh machine', async () => {
  const repo = makeRepo();
  const root = await newProject();
  await install(root, repo, { names: names({ agent: ['bug-finder'], rule: ['ts-style'] }), targets: ['claude', 'codex'] });
  // Forget this machine's install record, as if the project was just cloned.
  writeFileSync(join(m.home, '.morf', 'installed.json'), JSON.stringify({ version: 3, items: {} }));
  const before = snapshot(root);
  const res = await sync(root, { frozen: true, yes: false, allowExec: false });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Nothing to do/);
  assert.deepEqual(snapshot(root), before);
});
