// The project file and the lockfile: contents, determinism, what may never be written.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { sandbox, tmp, cleanup, makeRepo, snapshot, read, readJson, write, exists, FIXTURE, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { names, newProject, install, sync } = projectKit(m);

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
  assert.throws(() => clean('user:pw@github.com:acme/agents.git'), /not valid/);
  // Neither refusal repeats the credential.
  for (const bad of ['user:hunter2@github.com:acme/agents.git', 'https://user:hunter2@-bad-host/x', 'https://user:hunter2@github.com/a/b?t=hunter2']) {
    try { clean(bad); assert.fail('accepted ' + bad); } catch (e) { assert.ok(!e.message.includes('hunter2'), e.message); }
  }
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
