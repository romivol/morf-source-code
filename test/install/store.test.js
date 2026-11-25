import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentHash, write, remove } from '../../src/install/store.js';
import { scanRepo } from '../../src/repo/scan.js';
import { parseJsonc } from '../../src/install/json-file.js';

// Store functions take a `loc`; build them by hand so tests stay in a temp dir.
function tmp() {
  return mkdtempSync(join(tmpdir(), 'morf-test-'));
}
const read = p => JSON.parse(readFileSync(p, 'utf8'));

test('json entry: write merges, detects edits, remove leaves other keys', async () => {
  const dir = tmp();
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 }));
  const loc = { type: 'mcp', name: 'ctx', kind: 'json', destPath: file,
    mapping: { kind: 'json', file, path: ['mcpServers'], mode: 'entry' } };

  assert.equal(await currentHash(loc), null);
  const { hash } = await write(loc, { value: { command: 'npx' } });
  assert.equal(await currentHash(loc), hash);
  assert.deepEqual(read(file), { mcpServers: { mine: { command: 'x' }, ctx: { command: 'npx' } }, other: 1 });

  const edited = read(file);
  edited.mcpServers.ctx.command = 'changed';
  writeFileSync(file, JSON.stringify(edited));
  assert.notEqual(await currentHash(loc), hash);

  await remove(loc);
  assert.deepEqual(read(file), { mcpServers: { mine: { command: 'x' } }, other: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test('json hooks: entries are appended once, tracked by payload and removed exactly', async () => {
  const dir = tmp();
  const file = join(dir, 'settings.json');
  const mine = { matcher: 'Read', hooks: [{ type: 'command', command: 'mine' }] };
  writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PreToolUse: [mine] } }));
  const loc = { type: 'hook', name: 'guard', kind: 'json', destPath: file,
    mapping: { kind: 'json', file, path: ['hooks'], mode: 'hooks' } };
  const value = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }], Stop: [{ hooks: [{ type: 'command', command: 'bye' }] }] };

  const first = await write(loc, { value });
  const record = { payload: first.payload };
  assert.equal(await currentHash(loc, record), first.hash);
  assert.equal(read(file).hooks.PreToolUse.length, 2);

  // Writing again must not duplicate entries.
  await write(loc, { value }, record);
  assert.equal(read(file).hooks.PreToolUse.length, 2);

  // Deleting one of morf's entries by hand shows up as a local change.
  const edited = read(file);
  delete edited.hooks.Stop;
  writeFileSync(file, JSON.stringify(edited));
  assert.equal(await currentHash(loc, record), 'partial');

  await remove(loc, record);
  assert.deepEqual(read(file), { model: 'x', hooks: { PreToolUse: [mine] } });
  rmSync(dir, { recursive: true, force: true });
});

test('json: a new file is seeded with init, and an unparseable file is never overwritten', async () => {
  const dir = tmp();
  const file = join(dir, 'hooks.json');
  const loc = { type: 'hook', name: 'g', kind: 'json', destPath: file,
    mapping: { kind: 'json', file, path: ['hooks'], mode: 'hooks', init: { version: 1 } } };
  await write(loc, { value: { stop: [{ command: 'x' }] } });
  assert.deepEqual(read(file), { version: 1, hooks: { stop: [{ command: 'x' }] } });

  writeFileSync(file, '{ not json');
  await assert.rejects(() => write(loc, { value: { stop: [{ command: 'y' }] } }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  rmSync(dir, { recursive: true, force: true });
});

test('json: a commented config keeps its comments; removing the entry restores the file exactly', async () => {
  const dir = tmp();
  const file = join(dir, 'kilo.jsonc');
  const original = '{\n  // my model\n  "model": "a/b", /* keep */\n  "mcp": { "x": { "url": "https://e/x" }, },\n}\n';
  writeFileSync(file, original);
  const loc = { type: 'mcp', name: 'y', kind: 'json', destPath: file,
    mapping: { kind: 'json', file, path: ['mcp'], mode: 'entry' } };
  await write(loc, { value: { type: 'remote', url: 'https://e/y' } });
  const after = readFileSync(file, 'utf8');
  assert.match(after, /\/\/ my model/);
  assert.match(after, /\/\* keep \*\//);
  assert.deepEqual(parseJsonc(after).data.mcp, { x: { url: 'https://e/x' }, y: { type: 'remote', url: 'https://e/y' } });
  await remove(loc);
  assert.equal(readFileSync(file, 'utf8'), original);
  rmSync(dir, { recursive: true, force: true });
});

test('block: written between markers, replaced in place, removed cleanly', async () => {
  const dir = tmp();
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'model = "gpt"\n');
  const loc = { type: 'mcp', name: 'ctx', kind: 'block', destPath: file,
    mapping: { kind: 'block', file, style: 'toml' } };

  const a = await write(loc, { text: '[mcp_servers.ctx]\ncommand = "npx"\n' });
  assert.equal(await currentHash(loc), a.hash);
  assert.equal(readFileSync(file, 'utf8'),
    'model = "gpt"\n\n# >>> morf mcp:ctx\n[mcp_servers.ctx]\ncommand = "npx"\n# <<< morf mcp:ctx\n');

  const b = await write(loc, { text: '[mcp_servers.ctx]\ncommand = "node"\n' });
  assert.notEqual(a.hash, b.hash);
  assert.equal(readFileSync(file, 'utf8').match(/>>> morf/g).length, 1);

  await remove(loc);
  assert.equal(readFileSync(file, 'utf8'), 'model = "gpt"\n');
  rmSync(dir, { recursive: true, force: true });
});

test('block: refuses to duplicate a TOML table defined outside morf', async () => {
  const dir = tmp();
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[mcp_servers.ctx]\ncommand = "mine"\n');
  const loc = { type: 'mcp', name: 'ctx', kind: 'block', destPath: file,
    mapping: { kind: 'block', file, style: 'toml' } };
  await assert.rejects(() => write(loc, { text: '[mcp_servers.ctx]\ncommand = "npx"\n' }), /already defined/);
  assert.equal(readFileSync(file, 'utf8'), '[mcp_servers.ctx]\ncommand = "mine"\n');
  rmSync(dir, { recursive: true, force: true });
});

test('file with register: path is listed in the config array and unlisted on remove', async () => {
  const dir = tmp();
  const base = join(dir, 'rules');
  const cfg = join(dir, 'opencode.json');
  const destPath = join(base, 'style.md');
  const loc = { type: 'rule', name: 'style', kind: 'file', destPath,
    mapping: { kind: 'file', base, ext: '.md', register: { file: cfg, key: 'instructions' } } };

  await write(loc, { text: 'Be tidy.\n' });
  assert.equal(readFileSync(destPath, 'utf8'), 'Be tidy.\n');
  assert.deepEqual(read(cfg).instructions, [destPath.replace(/\\/g, '/')]);
  await write(loc, { text: 'Be tidy.\n' });
  assert.equal(read(cfg).instructions.length, 1);

  await remove(loc);
  assert.equal(existsSync(destPath), false);
  assert.equal(read(cfg).instructions, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('scanRepo finds every primitive and flags unparseable files', async () => {
  const dir = tmp();
  const w = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  w('skills/s1/SKILL.md', 'x');
  w('skills/not-a-skill/readme.md', 'x');
  w('agents/a1.md', 'x');
  w('rules/r1.mdc', 'x');
  w('prompts/p1.md', 'x');
  w('commands/p2.md', 'x');
  w('hooks/h1.json', JSON.stringify({ hooks: { Stop: [] } }));
  w('hooks/bad.json', '{ nope');
  w('mcp/one.json', JSON.stringify({ command: 'npx' }));
  w('.mcp.json', JSON.stringify({ mcpServers: { two: { url: 'https://e' }, three: { nothing: true } } }));

  const items = await scanRepo(dir);
  const key = i => `${i.type}:${i.name}`;
  assert.deepEqual(items.map(key).sort(), [
    'agent:a1', 'hook:bad', 'hook:h1', 'mcp:one', 'mcp:three', 'mcp:two',
    'prompt:p1', 'prompt:p2', 'rule:r1', 'skill:s1',
  ]);
  assert.deepEqual(items.find(i => key(i) === 'hook:h1').payload, { Stop: [] });
  assert.match(items.find(i => key(i) === 'hook:bad').invalid, /invalid hook file/);
  assert.match(items.find(i => key(i) === 'mcp:three').invalid, /command/);
  rmSync(dir, { recursive: true, force: true });
});
