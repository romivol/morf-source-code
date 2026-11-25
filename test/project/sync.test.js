// morf sync: one test per row of the behaviour table.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox, tmp, cleanup, makeRepo, fakeIo, run, snapshot, read, readJson, write, exists, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { NAMES, names, ctx, newProject, install, sync, stored, handWritten } = projectKit(m);

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
