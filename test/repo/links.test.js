// Symbolic links and submodules in a source repository are refused: the item
// that is one, or contains one, fails with a message naming it, and nothing
// from that item is installed. A link is never followed and never copied.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { lstatSync, symlinkSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sandbox, tmp, cleanup, makeRepo, run, snapshot, write, exists, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, NAMES, names, ctx, newProject, stored } = projectKit(m);
const { scanRepo } = await import('../../src/repo/scan.js');
const { copyDir, hashPath } = await import('../../src/util/fs.js');

const SECRET = 'CANARY-CONTENT-OUTSIDE-THE-REPO';
const SKILL = '---\nname: s\ndescription: d\n---\nbody\n';

// A repository with one clean skill and agent, and items that are or contain
// links (one pointing inside the repo, one outside) or a submodule.
function linkRepo() {
  const outside = tmp('morf-outside-');
  write(outside, 'secret.txt', SECRET);
  const target = join(outside, 'secret.txt').replace(/\\/g, '/');
  const repo = makeRepo({
    'skills/clean-skill/SKILL.md': SKILL,
    'agents/clean-agent.md': '---\nname: clean-agent\ndescription: d\n---\nbody\n',
    'README.md': 'readme\n',
  });
  repo.commitEntries([
    { path: 'skills/link-inside/SKILL.md', content: SKILL },
    { mode: '120000', path: 'skills/link-inside/docs/readme-link', content: '../../../README.md' },
    { path: 'skills/link-outside/SKILL.md', content: SKILL },
    { mode: '120000', path: 'skills/link-outside/secret', content: target },
    { mode: '120000', path: 'agents/linked-agent.md', content: target },
    { path: 'skills/with-submodule/SKILL.md', content: SKILL },
    { mode: '160000', path: 'skills/with-submodule/vendor', content: repo.first },
    { path: '.gitmodules', content: '[submodule "vendor"]\n\tpath = skills/with-submodule/vendor\n\turl = ext::sh -c "touch SUBMODULE-MARK"\n' },
  ]);
  return { repo, outside };
}

// No file under any of the directories may hold what the outside link points to.
function assertSecretNotCopied(...dirs) {
  for (const dir of dirs) {
    for (const key of Object.keys(snapshot(dir))) {
      const rel = key.slice(key.indexOf(':', 3) + 1);
      assert.ok(!readFileSync(join(dir, rel), 'utf8').includes(SECRET), `${rel} holds the content behind a link`);
    }
  }
}

test('a checkout made by morf never contains a real link, on any system', async () => {
  const { repo } = linkRepo();
  const clone = await m.openClone(repo.dir, { ref: 'main' });
  try {
    for (const p of ['skills/link-inside/docs/readme-link', 'skills/link-outside/secret', 'agents/linked-agent.md']) {
      assert.ok(!lstatSync(join(clone.dir, p)).isSymbolicLink(), `${p} was checked out as a link`);
    }
    const special = await m.specialEntries(clone.dir);
    assert.deepEqual(special.symlinks.sort(),
      ['agents/linked-agent.md', 'skills/link-inside/docs/readme-link', 'skills/link-outside/secret']);
    assert.deepEqual(special.submodules, ['skills/with-submodule/vendor']);

    const items = await m.scanClone(clone.dir);
    const by = Object.fromEntries(items.map(i => [`${i.type}:${i.name}`, i]));
    assert.equal(by['skill:clean-skill'].invalid, undefined);
    assert.equal(by['agent:clean-agent'].invalid, undefined);
    assert.match(by['skill:link-inside'].invalid, /symbolic link \(skills\/link-inside\/docs\/readme-link\)/);
    assert.match(by['skill:link-outside'].invalid, /symbolic link \(skills\/link-outside\/secret\)/);
    assert.match(by['agent:linked-agent'].invalid, /symbolic link \(agents\/linked-agent\.md\)/);
    assert.match(by['skill:with-submodule'].invalid, /git submodule \(skills\/with-submodule\/vendor\)/);
  } finally {
    await clone.close();
  }
  assert.ok(m.gitCalls.every(c => c.args[0] === '-c' && c.args[1] === 'core.symlinks=false'));
});

test('global install: linked items fail by name, clean items install, nothing behind a link is copied', () => {
  const { repo, outside } = linkRepo();
  const cwd = tmp('morf-global-');
  const res = spawnSync(process.execPath, [CLI, 'install', repo.dir, '--target', 'claude', 'codex'],
    { cwd, encoding: 'utf8', env: { ...process.env, MORF_ASCII: '1' } });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const out = res.stdout + res.stderr;
  assert.match(out, /link-inside\s+\[FAIL\]\s+contains a symbolic link \(skills\/link-inside\/docs\/readme-link\)/);
  assert.match(out, /link-outside\s+\[FAIL\]\s+contains a symbolic link \(skills\/link-outside\/secret\)/);
  assert.match(out, /linked-agent\s+\[FAIL\]\s+contains a symbolic link \(agents\/linked-agent\.md\)/);
  assert.match(out, /with-submodule\s+\[FAIL\]\s+contains a git submodule/);

  assert.ok(exists(m.home, '.claude/skills/clean-skill/SKILL.md'));
  assert.ok(exists(m.home, '.claude/agents/clean-agent.md'));
  for (const gone of ['.claude/skills/link-inside', '.claude/skills/link-outside', '.claude/agents/linked-agent.md',
    '.claude/skills/with-submodule', '.codex/skills/link-outside', '.codex/agents/linked-agent.toml']) {
    assert.ok(!exists(m.home, gone), `${gone} was installed`);
  }
  assertSecretNotCopied(m.home, cwd);
  assert.ok(!exists(cwd, 'SUBMODULE-MARK') && !exists(outside, 'SUBMODULE-MARK'), 'the submodule URL was used');
});

test('project mode: a linked item stops the command, and nothing is written', async () => {
  const { repo } = linkRepo();

  // Everything in the repo.
  const root = await newProject();
  const before = snapshot(root);
  const all = await run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: NAMES(), all: true, targets: ['claude', 'cursor'], force: false, ref: null, yes: true, allowExec: true,
  }, ctx(root)));
  assert.equal(all.code, 1);
  assert.match(all.out, /symbolic link \(/);
  assert.deepEqual(snapshot(root), before);

  // Named in the project file, reached through sync.
  const viaSync = await newProject();
  await m.writeProjectFile(viaSync, { sources: [{ repo: stored(viaSync, repo), ref: 'main', targets: ['claude'],
    items: [{ type: 'skill', name: 'link-outside' }] }] });
  const snap = snapshot(viaSync);
  for (const flags of [{}, { dryRun: true }, { check: true }]) {
    const res = await run(() => m.syncCommand({ yes: true, allowExec: true, ...flags }, ctx(viaSync)));
    assert.equal(res.code, 1, JSON.stringify(flags));
    // --check does not fetch a source that is not locked yet; it reports the
    // missing lockfile entry instead. The others fetch it and name the link.
    if (!flags.check) assert.match(res.out, /symbolic link \(skills\/link-outside\/secret\)/);
    assert.deepEqual(snapshot(viaSync), snap);
  }
  assertSecretNotCopied(root, viaSync, m.home);

  // The clean items from the same repository still install.
  const clean = await newProject();
  const ok = await run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: names({ skill: ['clean-skill'], agent: ['clean-agent'] }), all: false, targets: ['claude'],
    force: false, ref: null, yes: true, allowExec: true,
  }, ctx(clean)));
  assert.equal(ok.code, 0, ok.out);
  assert.ok(exists(clean, '.claude/skills/clean-skill/SKILL.md'));
});

test('a link that really exists on disk is refused by the scanner, the copier and both hashes', async (t) => {
  const dir = tmp('morf-links-');
  const outside = tmp('morf-outside-');
  write(outside, 'secret.txt', SECRET);
  write(dir, 'skills/in/SKILL.md', SKILL);
  write(dir, 'skills/out/SKILL.md', SKILL);
  write(dir, 'skills/ok/SKILL.md', SKILL);
  write(dir, 'README.md', 'readme\n');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'in', 'deep'), { recursive: true });
  try {
    symlinkSync(join(dir, 'README.md'), join(dir, 'skills', 'in', 'deep', 'inside-link'));
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'skills', 'out', 'outside-link'));
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'agents', 'linked.md'));
    symlinkSync(join(dir, 'skills', 'ok'), join(dir, 'skills', 'linked-dir'), 'dir');
  } catch (e) {
    t.skip(`this system does not let the test create symbolic links (${e.code})`);
    return;
  }

  const items = await scanRepo(dir);
  const by = Object.fromEntries(items.map(i => [`${i.type}:${i.name}`, i]));
  assert.equal(by['skill:ok'].invalid, undefined);
  assert.match(by['skill:in'].invalid, /symbolic link \(skills\/in\/deep\/inside-link\)/);
  assert.match(by['skill:out'].invalid, /symbolic link \(skills\/out\/outside-link\)/);
  assert.match(by['agent:linked'].invalid, /symbolic link \(agents\/linked\.md\)/);
  assert.match(by['skill:linked-dir'].invalid, /symbolic link \(skills\/linked-dir\)/);

  // Even if a caller ignored `invalid`, nothing copies or hashes through a link.
  for (const skill of ['in', 'out']) {
    const src = join(dir, 'skills', skill);
    await assert.rejects(() => m.portableHashPath(src), /symbolic link/);
    await assert.rejects(() => hashPath(src, { strict: true }), /symbolic link/);
    const dest = join(tmp('morf-dest-'), skill);
    await assert.rejects(() => copyDir(src, dest), /symbolic link/);
    assert.ok(!exists(dest, '.'), 'a partial copy was left behind');
  }
  await assert.rejects(() => m.portableHashPath(join(dir, 'agents', 'linked.md')), /symbolic link/);
  await assert.rejects(() => hashPath(join(dir, 'agents', 'linked.md'), { strict: true }), /symbolic link/);

  // A clean directory still hashes and copies.
  const dest = join(tmp('morf-dest-'), 'ok');
  await copyDir(join(dir, 'skills', 'ok'), dest);
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), SKILL);
  assert.match(await m.portableHashPath(join(dir, 'skills', 'ok')), /^sha256:/);
  writeFileSync(join(dir, 'unused'), '');
});
