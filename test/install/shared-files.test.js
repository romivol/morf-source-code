// Files morf shares with the user: only morf's own entries may change. Every
// other byte — comments, key order, spacing, line endings — stays as written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { write, remove, currentHash, locate } from '../../src/install/store.js';
import { setPath, removePath, arrayAppend, arrayRemove, getPath } from '../../src/install/json-edit.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'morf-shared-'));
const text = p => readFileSync(p, 'utf8');

function jsonLoc(file, path, mode, name, type = 'mcp', extra = {}) {
  return { type, name, kind: 'json', destPath: file, mapping: { kind: 'json', file, path, mode, ...extra } };
}

// Every line of `original` must still be in `after`, in the same order.
function assertLinesKept(original, after) {
  let at = 0;
  for (const line of original.split('\n')) {
    if (line.trim() === '' || /^[\]}],?$/.test(line.trim())) continue;
    const idx = after.indexOf(line.replace(/,?\s*$/, ''), at);
    assert.notEqual(idx, -1, `line lost or reordered: ${JSON.stringify(line)}`);
    at = idx;
  }
}

const SHAPES = {
  'two-space': '{\n  "zeta": 1,\n  "alpha": { "b": [1, 2], "a": true },\n  "mcpServers": {\n    "mine": { "command": "x" }\n  }\n}\n',
  'four-space, no final newline': '{\n    "zeta": 1,\n    "mcpServers": {\n        "mine": {\n            "command": "x"\n        }\n    },\n    "alpha": null\n}',
  'one line': '{"zeta":1,"mcpServers":{"mine":{"command":"x"}},"alpha":2}\n',
  'jsonc with comments and trailing commas': '// header\n{\n  /* block */\n  "zeta": 1, // why\n  "mcpServers": {\n    "mine": { "command": "x" }, // mine\n  },\n}\n',
  'CRLF': '{\r\n  "zeta": 1,\r\n  "mcpServers": {\r\n    "mine": { "command": "x" }\r\n  }\r\n}\r\n',
  'no section yet': '{\n  "zeta": 1,\n  "alpha": 2\n}\n',
  'empty object': '{}\n',
};

for (const [label, original] of Object.entries(SHAPES)) {
  test(`json entry (${label}): only morf's entry changes; removing it restores the file byte for byte`, async () => {
    const dir = tmp();
    const file = join(dir, 'mcp.json');
    writeFileSync(file, original);
    const loc = jsonLoc(file, ['mcpServers'], 'entry', 'ctx');
    const value = { command: 'npx', args: ['-y', 'pkg'], env: { K: '${K}' } };

    await write(loc, { value });
    const after = text(file);
    // (A file written on a single line has no separate lines to compare; the
    // byte-for-byte restore below covers it.)
    if (original.trim().includes('\n')) assertLinesKept(original, after);
    assert.deepEqual(getPath(after, ['mcpServers', 'ctx']), value);
    assert.equal(after.includes('\r\n'), original.includes('\r\n'), 'line endings kept');
    if (original.includes('"mine"')) assert.deepEqual(getPath(after, ['mcpServers', 'mine']), { command: 'x' });

    // Installing twice changes nothing more.
    await write(loc, { value });
    assert.equal(text(file), after);

    await remove(loc);
    if (original.includes('"mcpServers"')) assert.equal(text(file), original);
    else assert.deepEqual(getPath(text(file), ['zeta']), getPath(original, ['zeta']));
    rmSync(dir, { recursive: true, force: true });
  });
}

test('hooks: user hooks and other settings are untouched; twice is not doubled; remove restores exactly', async () => {
  const dir = tmp();
  const file = join(dir, 'settings.json');
  const original = '{\n  "permissions": { "allow": ["Bash(npm test)"] },\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Read", "hooks": [{ "type": "command", "command": "mine" }] }\n    ]\n  },\n  "model": "opus"\n}\n';
  writeFileSync(file, original);
  const loc = jsonLoc(file, ['hooks'], 'hooks', 'guard', 'hook');
  const value = {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'bye' }] }],
  };

  const first = await write(loc, { value });
  const record = { payload: first.payload };
  const after = text(file);
  assertLinesKept(original, after);
  assert.equal(getPath(after, ['hooks', 'PreToolUse']).length, 2);
  assert.ok(after.indexOf('"permissions"') < after.indexOf('"hooks"') && after.indexOf('"hooks"') < after.indexOf('"model"'), 'key order kept');

  await write(loc, { value }, record);
  assert.equal(text(file), after, 'no duplicate entries');
  assert.equal(await currentHash(loc, record), first.hash);

  await remove(loc, record);
  assert.equal(text(file), original);
  rmSync(dir, { recursive: true, force: true });
});

test('a registered path goes into a commented config without disturbing it', async () => {
  const dir = tmp();
  const base = join(dir, '.opencode', 'rules');
  const cfg = join(dir, 'opencode.jsonc');
  const original = '{\n  // which model\n  "model": "anthropic/claude", // pinned\n  "instructions": [\n    "docs/style.md" // ours\n  ]\n}\n';
  writeFileSync(cfg, original);
  const destPath = join(base, 'ts.md');
  const loc = { type: 'rule', name: 'ts', kind: 'file', destPath,
    mapping: { kind: 'file', base, ext: '.md', register: { file: cfg, key: 'instructions', relativeTo: dir } } };

  await write(loc, { text: 'Be tidy.\n' });
  await write(loc, { text: 'Be tidy.\n' });
  const after = text(cfg);
  // The only change to the user's lines is the comma JSON needs after their entry.
  assert.equal(after, original.replace('"docs/style.md" // ours', '"docs/style.md", // ours\n    ".opencode/rules/ts.md"'));
  assert.deepEqual(getPath(after, ['instructions']), ['docs/style.md', '.opencode/rules/ts.md']);
  await remove(loc);
  assert.equal(text(cfg), original);
  rmSync(dir, { recursive: true, force: true });
});

test('a file that cannot be parsed is reported and never overwritten', async () => {
  const dir = tmp();
  for (const broken of ['{ "a": 1,, }x', '{ "mcpServers": [', 'not json at all', '[1, 2]']) {
    const file = join(dir, 'mcp.json');
    writeFileSync(file, broken);
    const loc = jsonLoc(file, ['mcpServers'], 'entry', 'ctx');
    await assert.rejects(() => write(loc, { value: { command: 'npx' } }), /left it untouched/);
    await assert.rejects(() => remove(loc), /left it untouched/);
    assert.equal(text(file), broken);
    assert.ok(!existsSync(file + '.morf-backup'));
  }
  rmSync(dir, { recursive: true, force: true });
});

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`AGENTS.md (${label}): morf's block sits between markers; nothing outside them changes`, async () => {
    const dir = tmp();
    const file = join(dir, 'AGENTS.md');
    const original = ['# Project notes', '', 'Run `npm test` before pushing.   ', '', '<!-- a comment of mine -->', ''].join(eol);
    writeFileSync(file, original);
    const loc = { type: 'rule', name: 'ts-style', kind: 'block', destPath: file, mapping: { kind: 'block', file, style: 'md' } };

    const a = await write(loc, { text: '## ts-style\n\n- Use named exports\n' });
    const after = text(file);
    assert.ok(after.startsWith(original), 'everything the user wrote is still there, unchanged');
    assert.match(after, /<!-- morf:rule:ts-style -->\r?\n## ts-style[\s\S]*<!-- \/morf:rule:ts-style -->/);
    assert.equal(await currentHash(loc), a.hash);

    // Twice: still one block. Content the user adds after the block survives an update.
    await write(loc, { text: '## ts-style\n\n- Use named exports\n' });
    assert.equal(text(file), after);
    writeFileSync(file, after + `${eol}## My later section${eol}`);
    await write(loc, { text: '## ts-style\n\n- Changed\n' });
    const updated = text(file);
    assert.equal(updated.match(/<!-- morf:rule:ts-style -->/g).length, 1);
    assert.ok(updated.startsWith(original));
    assert.ok(updated.endsWith(`${eol}## My later section${eol}`));

    await remove(loc);
    assert.equal(text(file), original + `${eol}## My later section${eol}`);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('config.toml: comments and other tables are untouched; remove restores the file exactly', async () => {
  const dir = tmp();
  const file = join(dir, 'config.toml');
  const original = '# my codex config\nmodel = "gpt-5"   # pinned\n\n[mcp_servers.mine]\ncommand = "x"\n';
  writeFileSync(file, original);
  const loc = { type: 'mcp', name: 'ctx', kind: 'block', destPath: file, mapping: { kind: 'block', file, style: 'toml' } };
  await write(loc, { text: '[mcp_servers.ctx]\ncommand = "npx"\n' });
  await write(loc, { text: '[mcp_servers.ctx]\ncommand = "npx"\n' });
  const after = text(file);
  assert.ok(after.startsWith(original));
  assert.equal(after.match(/\[mcp_servers\.ctx\]/g).length, 1);
  await remove(loc);
  assert.equal(text(file), original);
  rmSync(dir, { recursive: true, force: true });
});

test('a file with no final newline does not gain one', async () => {
  const dir = tmp();
  for (const [name, style, original, block] of [
    ['AGENTS.md', 'md', '# Notes\n\nNo newline at the end', '## rule\n\n- x\n'],
    ['AGENTS.md', 'md', '# Notes\r\n\r\nNo newline at the end', '## rule\n\n- x\n'],
    ['config.toml', 'toml', 'model = "gpt-5"', '[mcp_servers.ctx]\ncommand = "npx"\n'],
  ]) {
    const file = join(dir, name);
    writeFileSync(file, original);
    const loc = { type: style === 'md' ? 'rule' : 'mcp', name: 'ctx', kind: 'block', destPath: file, mapping: { kind: 'block', file, style } };
    await write(loc, { text: block });
    const after = text(file);
    assert.ok(after.startsWith(original));
    assert.ok(!/[\r\n]$/.test(after), 'still no final newline while the block is installed');
    await write(loc, { text: block });
    assert.equal(text(file), after);
    await remove(loc);
    assert.equal(text(file), original);
  }
  // JSON too.
  const file = join(dir, 'settings.json');
  const original = '{\n  "model": "opus"\n}';
  writeFileSync(file, original);
  const loc = jsonLoc(file, ['mcpServers'], 'entry', 'ctx');
  await write(loc, { value: { command: 'npx' } });
  assert.ok(!text(file).endsWith('\n'));
  rmSync(dir, { recursive: true, force: true });
});

test('global mode: a user file is backed up once before its first change; project mode makes no backup', async () => {
  const dir = tmp();
  const cases = [
    ['mcp.json', '{\n  // mine\n  "mcpServers": {}\n}\n',
      f => jsonLoc(f, ['mcpServers'], 'entry', 'ctx'), { value: { command: 'npx' } }, { value: { command: 'node' } }],
    ['AGENTS.md', '# mine\n',
      f => ({ type: 'rule', name: 'r', kind: 'block', destPath: f, mapping: { kind: 'block', file: f, style: 'md' } }),
      { text: 'one\n' }, { text: 'two\n' }],
  ];
  for (const [name, original, makeLoc, first, second] of cases) {
    const file = join(dir, name);

    // Project mode (no backup flag): nothing extra is written.
    writeFileSync(file, original);
    await write(makeLoc(file), first);
    assert.ok(!existsSync(file + '.morf-backup'));

    // Global mode: the original is kept, and a later change does not replace it.
    writeFileSync(file, original);
    const loc = { ...makeLoc(file), backup: true };
    await write(loc, first);
    assert.equal(text(file + '.morf-backup'), original);
    await write(loc, second);
    await remove(loc);
    assert.equal(text(file + '.morf-backup'), original);
    rmSync(file + '.morf-backup');
  }

  // A file morf creates itself has nothing to back up.
  const fresh = join(dir, 'new.json');
  await write({ ...jsonLoc(fresh, ['mcpServers'], 'entry', 'ctx'), backup: true }, { value: { command: 'npx' } });
  assert.ok(!existsSync(fresh + '.morf-backup'));

  // A change that changes nothing makes no backup either.
  const same = join(dir, 'same.json');
  writeFileSync(same, '{\n  "mcpServers": {\n    "ctx": { "command": "npx" }\n  }\n}\n');
  await write({ ...jsonLoc(same, ['mcpServers'], 'entry', 'ctx'), backup: true }, { value: { command: 'npx' } });
  assert.ok(!existsSync(same + '.morf-backup'));
  rmSync(dir, { recursive: true, force: true });
});

test('locate asks for a backup only for global installs into shared files under the home directory', () => {
  assert.equal(locate('claude', 'mcp', 'x').backup, true);        // ~/.claude.json
  assert.equal(locate('claude', 'hook', 'x').backup, true);       // ~/.claude/settings.json
  assert.equal(locate('opencode', 'rule', 'x').backup, true);     // registers in ~/.config/opencode/opencode.json
  assert.equal(locate('claude', 'agent', 'x').backup, false);     // morf's own file
  const scope = { project: join(tmpdir(), 'some-project') };
  for (const [target, type] of [['claude', 'mcp'], ['claude', 'hook'], ['opencode', 'rule'], ['codex', 'mcp']]) {
    assert.equal(locate(target, type, 'x', scope).backup, false);
  }
});

test('jsonedit: edits round-trip on awkward inputs', () => {
  const cases = [
    '{}',
    '{\n}\n',
    '{ "a": 1 }',
    '{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n',
    '{\n  "a": [\n    1, // one\n    2\n  ]\n}\n',
    '{\n  "s": "a \\"quoted\\" // not a comment, { not a brace }",\n  "t": 2\n}\n',
  ];
  for (const original of cases) {
    const added = setPath(original, ['x', 'y'], { z: [1, { w: 'v' }] });
    assert.deepEqual(getPath(added, ['x', 'y']), { z: [1, { w: 'v' }] });
    // An object that was empty has no layout to restore; anything else comes
    // back exactly.
    const removed = removePath(added, ['x']);
    if (/^\{\s*\}\s*$/.test(original)) assert.deepEqual(getPath(removed, []), {});
    else assert.equal(removed, original);
    const arr = arrayAppend(arrayAppend(original, ['list'], 'p'), ['list'], 'q');
    assert.deepEqual(getPath(arr, ['list']), ['p', 'q']);
    assert.equal(arrayAppend(arr, ['list'], 'p'), arr, 'no duplicates');
    assert.deepEqual(getPath(arrayRemove(arr, ['list'], 'p'), ['list']), ['q']);
    assert.deepEqual(getPath(arrayRemove(arrayRemove(arr, ['list'], 'q'), ['list'], 'p'), ['list']), []);
  }
  // Replacing a value keeps the neighbours and their comments.
  const doc = '{\n  "keep": 1, // note\n  "x": { "old": true },\n  "after": 2\n}\n';
  const replaced = setPath(doc, ['x'], { new: 1 });
  assert.match(replaced, /"keep": 1, \/\/ note/);
  assert.match(replaced, /"after": 2/);
  assert.deepEqual(getPath(replaced, ['x']), { new: 1 });
});
