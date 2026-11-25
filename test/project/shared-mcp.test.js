// The project .mcp.json is read by Claude Code and by Copilot. Each entry is
// written once, in a shape both accept: a remote entry must not carry "tools",
// because Claude Code drops such an entry without saying so.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sandbox, cleanup, makeRepo, readJson, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { names, newProject, install, sync } = projectKit(m);

const LOCAL = { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: '${API_KEY}' } };
const REMOTE = { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } };
const repo = () => makeRepo({
  'mcp/local-one.json': JSON.stringify(LOCAL),
  'mcp/remote-one.json': JSON.stringify(REMOTE),
});
const both = names({ mcp: ['local-one', 'remote-one'] });

for (const targets of [['claude'], ['copilot'], ['claude', 'copilot']]) {
  test(`.mcp.json for ${targets.join(' + ')}: local entry has tools, remote entry does not`, async () => {
    const root = await newProject();
    const res = await install(root, repo(), { names: both, targets });
    assert.equal(res.code, 0, res.out);
    const servers = readJson(root, '.mcp.json').mcpServers;
    assert.deepEqual(servers['local-one'], { type: 'stdio', ...LOCAL, tools: ['*'] });
    assert.deepEqual(servers['remote-one'], REMOTE);
    assert.ok(!('tools' in servers['remote-one']));
    // What was written is what a second run expects to find.
    assert.match((await sync(root, { yes: false, allowExec: false })).out, /Nothing to do/);
  });
}

test('a remote entry written by an older morf (with tools) is rewritten on the next sync', async () => {
  const root = await newProject();
  const r = repo();
  assert.equal((await install(root, r, { names: both, targets: ['claude', 'copilot'] })).code, 0);
  // Put the file and the install record back to what converter version 2 left.
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  const file = join(root, '.mcp.json');
  const j = readJson(root, '.mcp.json');
  j.mcpServers['remote-one'].tools = ['*'];
  await fs.writeFile(file, JSON.stringify(j, null, 2) + '\n');
  const manifest = await m.readManifest();
  const { hashValue } = await import('../../src/install/json-file.js');
  for (const rec of m.recordsFor(manifest, root)) {
    if (rec.name !== 'remote-one') continue;
    rec.conv = 2;
    rec.hash = rec.installedHash = hashValue(j.mcpServers['remote-one']);
  }
  await m.writeManifest(manifest);

  const res = await sync(root);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(readJson(root, '.mcp.json').mcpServers['remote-one'], REMOTE);
});

// The real tool. Runs only where Claude Code is installed and the test is asked
// for (MORF_REAL_TOOL_TESTS=1); it makes no model call.
const claude = process.env.MORF_REAL_TOOL_TESTS === '1'
  ? spawnSync('claude', ['--version'], { encoding: 'utf8', shell: true })
  : { status: 1 };

test('Claude Code lists the remote entry morf writes', { skip: claude.status !== 0 && 'set MORF_REAL_TOOL_TESTS=1 with Claude Code installed' }, async () => {
  const root = await newProject();
  assert.equal((await install(root, repo(), { names: both, targets: ['claude', 'copilot'] })).code, 0);
  // HOME is the test sandbox here, so the real configuration is not read.
  const get = name => spawnSync('claude', ['mcp', 'get', name], { cwd: root, encoding: 'utf8', shell: true, timeout: 90000 });
  for (const name of ['remote-one', 'local-one']) {
    const res = get(name);
    assert.match(res.stdout + res.stderr, /Scope: Project config/, `${name}: ${res.stdout}${res.stderr}`);
  }
});
