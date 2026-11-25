// The approval rule: --yes, --allow-exec, --check, --dry-run and pruning.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, cleanup, makeRepo, fakeIo, run, snapshot, read, readJson, write, exists, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, NAMES, names, ctx, newProject, install, sync, stored, handWritten } = projectKit(m);

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
