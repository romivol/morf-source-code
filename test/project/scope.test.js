// Project detection, --global, the install record, and destinations two tools share.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sandbox, tmp, cleanup, makeRepo, run, snapshot, readJson, write, exists, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, NAMES, names, ctx, newProject, install, sync } = projectKit(m);

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
