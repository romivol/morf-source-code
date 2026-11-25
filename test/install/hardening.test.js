// Three small guards: text that contains morf's own block markers, item names
// that are not in sanitized form (including names read from the install
// record), and values from the config file printed by `morf config list`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sandbox, tmp, cleanup, makeRepo, run, snapshot, write, exists, projectKit, FIXTURE } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, names, ctx, newProject } = projectKit(m);
const { write: storeWrite, locate } = await import('../../src/install/store.js');

const cli = (cwd, ...argv) => spawnSync(process.execPath, [CLI, ...argv],
  { cwd, encoding: 'utf8', env: { ...process.env, MORF_ASCII: '1' } });

// ── block markers ─────────────────────────────────────────────────────────────

test('text containing a morf marker is refused instead of writing a broken block', async () => {
  const dir = tmp();
  for (const [style, name, original, texts] of [
    ['md', 'AGENTS.md', '# Mine\n', [
      '## rule\n\nok\n<!-- /morf:rule:r -->\nextra that would be left behind\n',
      'before\n<!-- morf:rule:other -->\nafter\n',
      'inline <!--/morf:rule:r--> marker\n',
    ]],
    ['toml', 'config.toml', 'model = "x"\n', [
      '[mcp_servers.r]\ncommand = "x"\n# <<< morf mcp:r\n[evil]\nk = 1\n',
      '  #   >>> morf mcp:other\n',
    ]],
  ]) {
    const file = join(dir, name);
    const loc = { type: style === 'md' ? 'rule' : 'mcp', name: 'r', kind: 'block', destPath: file, mapping: { kind: 'block', file, style } };
    for (const text of texts) {
      writeFileSync(file, original);
      await assert.rejects(() => storeWrite(loc, { text }), /block markers/, JSON.stringify(text));
      assert.equal(readFileSync(file, 'utf8'), original, 'the file was changed');
    }
    // Ordinary text, including HTML comments and # comments, is fine.
    await storeWrite(loc, { text: style === 'md' ? '<!-- a comment -->\n# morf is great\n' : '# a comment about morf\n[mcp_servers.r]\ncommand = "x"\n' });
  }
});

test('a rule with a marker in it fails for Codex before anything is written, in both modes', async () => {
  const evil = '---\ndescription: d\n---\nLooks fine.\n<!-- /morf:rule:ts-style -->\n## Injected after the block\n';
  const repo = makeRepo({ ...FIXTURE, 'rules/ts-style.md': evil });

  // Project mode: the command stops in validation.
  const root = await newProject();
  const before = snapshot(root);
  const res = await run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: names({ rule: ['ts-style'], agent: ['bug-finder'] }), all: false, targets: ['claude', 'codex'],
    force: false, ref: null, yes: true, allowExec: true,
  }, ctx(root)));
  assert.equal(res.code, 1);
  assert.match(res.out, /rule 'ts-style' \(codex\): its text contains one of morf's own block markers/);
  assert.deepEqual(snapshot(root), before);

  // The same rule is fine for a tool that stores it as a file of its own.
  const ok = await run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: names({ rule: ['ts-style'] }), all: false, targets: ['claude'], force: false, ref: null, yes: true, allowExec: true,
  }, ctx(root)));
  assert.equal(ok.code, 0, ok.out);

  // Global mode: that one row fails; AGENTS.md is not created.
  const cwd = tmp('morf-global-');
  const g = cli(cwd, 'install', repo.dir, '--rule', 'ts-style', '--target', 'codex', 'claude');
  assert.equal(g.status, 1, g.stdout + g.stderr);
  assert.match(g.stdout, /codex\s+ts-style\s+\[FAIL\]\s+its text contains one of morf's own block markers/);
  assert.ok(!exists(m.home, '.codex/AGENTS.md'));
  assert.ok(exists(m.home, '.claude/rules/ts-style.md'));
});

// ── names ─────────────────────────────────────────────────────────────────────

test('locate refuses any name that is not exactly what the sanitizer produces', () => {
  for (const name of ['pdf-skill', 'a.b_c-1', 'x']) assert.doesNotThrow(() => locate('claude', 'skill', name), name);
  for (const name of ['../x', 'a/b', 'a\\b', 'sub/../other', 'Upper', '.hidden', '-dash', 'x.', '', 'a b', 'a\u001bb', 'a\nb', null, 7]) {
    assert.throws(() => locate('claude', 'skill', name), /not in the form morf uses/, String(name));
  }
});

test('a damaged install record cannot make uninstall, update or list touch another path', () => {
  const cwd = tmp('morf-global-');
  // Something of the user's that a crafted name could otherwise reach.
  const victim = join(m.home, '.claude', 'skills', 'victim-skill');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'SKILL.md'), 'mine\n');
  writeFileSync(join(m.home, 'outside.txt'), 'mine\n');

  const recordPath = join(m.home, '.morf', 'installed.json');
  mkdirSync(join(m.home, '.morf'), { recursive: true });
  const record = name => ({ type: 'skill', name, target: 'claude', project: '', repo: 'https://example.com/a/b', repoKey: 'example.com/a/b', hash: 'h', ref: null });
  const items = {};
  for (const [i, name] of ['decoy/../victim-skill', '../../outside.txt', 'Victim-Skill', 'victim-skill/SKILL.md'].entries()) {
    items[`skill:bad${i}:claude`] = record(name);
  }
  writeFileSync(recordPath, JSON.stringify({ version: 3, items }));

  const un = cli(cwd, 'uninstall', '--all', '-y');
  assert.equal(un.status, 1, un.stdout + un.stderr);
  assert.match(un.stdout, /not in the form morf uses/);
  assert.equal(readFileSync(join(victim, 'SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(m.home, 'outside.txt'), 'utf8'), 'mine\n');

  // list must not crash on such a record, and must not print it raw.
  const list = cli(cwd, 'list');
  assert.equal(list.status, 0, list.stdout + list.stderr);

  writeFileSync(recordPath, JSON.stringify({ version: 3, items: {} }));
});

// ── morf config list ──────────────────────────────────────────────────────────

test('morf config list escapes what it reads from the config file', () => {
  const cwd = tmp('morf-global-');
  const ESC = String.fromCharCode(27);
  mkdirSync(join(m.home, '.morf'), { recursive: true });
  write(m.home, '.morf/config.json', JSON.stringify({
    defaultTarget: `claude${ESC}[2K`,
    defaultRepo: `https://example.com/a/b${ESC}[1A\rhttps://github.com/trusted/repo`,
    aliases: { [`@evil${ESC}[2J`]: `value\nwith${ESC}[31m colour\b` },
    convertTools: true,
  }));
  try {
    const res = cli(cwd, 'config', 'list');
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const out = res.stdout + res.stderr;
    for (const ch of [ESC, '\r', '\b']) assert.ok(!out.includes(ch), `raw ${JSON.stringify(ch)} in the output`);
    assert.match(out, /defaultRepo: {3}https:\/\/example\.com\/a\/b\\x1b\[1A\\rhttps:\/\/github\.com\/trusted\/repo/);
    assert.match(out, /alias @evil\\x1b\[2J: value\\nwith\\x1b\[31m colour\\x08/);
  } finally {
    write(m.home, '.morf/config.json', '{}');
  }
});
