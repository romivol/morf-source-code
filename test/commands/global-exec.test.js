// Global mode (no morf.json): hooks and MCP servers run commands, so they are
// never installed or replaced silently. Everything else installs as before.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sandbox, tmp, cleanup, makeRepo, fakeIo, run, read, readJson, exists, projectKit, FIXTURE } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, names } = projectKit(m);
const { installCommand } = await import('../../src/commands/install.js');
const { uninstallCommand } = await import('../../src/commands/uninstall.js');

const ALL = names({ agent: ['bug-finder'], hook: ['guard'], mcp: ['context7'] });
const args = (repo, over = {}) => ({
  repoArg: repo.dir, names: ALL, all: false, targets: ['claude'], force: false, ref: null, dryRun: false, ...over,
});

const hooksInstalled = () => exists(m.home, '.claude/settings.json') &&
  Boolean((readJson(m.home, '.claude/settings.json').hooks || {}).PreToolUse);
const mcpInstalled = () => exists(m.home, '.claude.json') &&
  Boolean((readJson(m.home, '.claude.json').mcpServers || {}).context7);
const agentInstalled = () => exists(m.home, '.claude/agents/bug-finder.md');

// Remove whatever a test installed, so the next one starts clean.
async function reset() {
  await run(() => uninstallCommand({ names: names({}), all: true, targets: [], force: true, dryRun: false }));
  assert.ok(!hooksInstalled() && !mcpInstalled() && !agentInstalled());
}

// A directory with no morf.json above it, to run the real CLI in global mode.
const cwd = tmp('morf-global-');
const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv],
  { cwd, encoding: 'utf8', env: { ...process.env, MORF_ASCII: '1' } });

test('interactive, accepted: the hook and MCP server are listed with their commands, then installed', async () => {
  const repo = makeRepo();
  const io = fakeIo({ tty: true, answers: ['y'] });
  const res = await run(() => installCommand(args(repo), io));
  assert.equal(io.asked.length, 1);
  assert.match(io.asked[0], /hooks and MCP servers.*\[y\/N\]/);
  assert.match(res.out, /These items run commands on your machine/);
  assert.match(res.out, /npx -y ctx7/);
  assert.match(res.out, /\.\/check\.sh/);
  // The list comes before anything is written.
  assert.ok(res.out.indexOf('These items run commands') < res.out.indexOf('TARGET'));
  assert.ok(hooksInstalled() && mcpInstalled() && agentInstalled());

  // Installing again changes nothing, so there is nothing to ask about.
  const again = fakeIo({ tty: true, answers: [] });
  await run(() => installCommand(args(repo), again));
  assert.equal(again.asked.length, 0);
  await reset();
});

test('interactive, declined (or just Enter): neither is installed; the agent still is', async () => {
  const repo = makeRepo();
  for (const answer of ['n', '']) {
    const io = fakeIo({ tty: true, answers: [answer] });
    const res = await run(() => installCommand(args(repo), io));
    assert.equal(io.asked.length, 1);
    assert.ok(!hooksInstalled(), 'hook installed after a no');
    assert.ok(!mcpInstalled(), 'MCP server installed after a no');
    assert.ok(agentInstalled(), 'the agent keeps installing as before');
    assert.match(res.out, /not approved/);
    await reset();
  }
});

test('interactive with --allow-exec: installed without a question', async () => {
  const repo = makeRepo();
  const io = fakeIo({ tty: true, answers: [] });
  await run(() => installCommand(args(repo, { allowExec: true }), io));
  assert.equal(io.asked.length, 0);
  assert.ok(hooksInstalled() && mcpInstalled());
  await reset();
});

test('no terminal, no flag: exit 1, the commands are shown, no hook or MCP server is installed', async () => {
  const repo = makeRepo();
  for (const argv of [
    ['install', repo.dir, '--agent', 'bug-finder', '--hook', 'guard', '--mcp', 'context7', '--target', 'claude'],
    ['install', repo.dir, '--target', 'claude'],          // everything in the repo
    ['install', repo.dir],                                // bare: every detected tool
  ]) {
    const res = cli(...argv);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /npx -y ctx7/);
    assert.match(res.stdout, /--allow-exec/);
    assert.ok(!hooksInstalled(), `hook installed by: morf ${argv.join(' ')}`);
    assert.ok(!mcpInstalled(), `MCP server installed by: morf ${argv.join(' ')}`);
    assert.ok(agentInstalled(), 'other kinds keep installing');
    await reset();
  }

  // CI is treated the same even if a terminal is attached.
  const io = fakeIo({ tty: true, env: { CI: '1' }, answers: ['y'] });
  const orig = process.exit;
  let code = null;
  process.exit = (c) => { code = c; };
  try {
    await run(() => installCommand(args(repo), io));
  } finally {
    process.exit = orig;
  }
  assert.equal(code, 1);
  assert.equal(io.asked.length, 0);
  assert.ok(!hooksInstalled() && !mcpInstalled());
  await reset();
});

test('no terminal, with --allow-exec: everything installs', async () => {
  const repo = makeRepo();
  const res = cli('install', repo.dir, '--target', 'claude', '--allow-exec');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.ok(hooksInstalled() && mcpInstalled() && agentInstalled());
  await reset();
});

test('--yes and -y do not stand in for --allow-exec', async () => {
  const repo = makeRepo();
  const res = cli('install', repo.dir, '--target', 'claude', '--yes', '--force');
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.ok(!hooksInstalled() && !mcpInstalled());
  await reset();
});

test('removing a hook or MCP server never needs the flag', async () => {
  const repo = makeRepo();
  assert.equal(cli('install', repo.dir, '--target', 'claude', '--allow-exec').status, 0);
  assert.ok(hooksInstalled() && mcpInstalled());
  const res = cli('uninstall', '--hook', 'guard', '--mcp', 'context7', '-y');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.ok(!hooksInstalled() && !mcpInstalled());
  await reset();
});

test('update: replacing a hook or MCP server needs approval too', async () => {
  const repo = makeRepo();
  assert.equal(cli('install', repo.dir, '--target', 'claude', '--allow-exec').status, 0);
  const before = read(m.home, '.claude/settings.json');
  repo.commit({
    'hooks/guard.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './changed.sh' }] }] } }),
    'agents/bug-finder.md': FIXTURE['agents/bug-finder.md'] + 'More.\n',
  });

  const refused = cli('update', '--all');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /\.\/changed\.sh/);
  assert.equal(read(m.home, '.claude/settings.json'), before, 'the hook was replaced without approval');
  assert.match(read(m.home, '.claude/agents/bug-finder.md'), /More\./, 'the agent still updates');

  const allowed = cli('update', '--all', '--allow-exec');
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.match(read(m.home, '.claude/settings.json'), /changed\.sh/);
  await reset();
});

test('--dry-run asks nothing and installs nothing', async () => {
  const repo = makeRepo();
  const io = fakeIo({ tty: true, answers: [] });
  await run(() => installCommand(args(repo, { dryRun: true }), io));
  assert.equal(io.asked.length, 0);
  assert.ok(!hooksInstalled() && !mcpInstalled() && !agentInstalled());
});
