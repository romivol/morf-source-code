// Uninstalling the last item from a directory morf created removes the
// directory too. A directory that was there before is left alone.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, tmp, cleanup, makeRepo, run, write, exists, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, NAMES, names, ctx, newProject, install } = projectKit(m);

const rule = name => `---\ndescription: d\n---\n${name}\n`;
const repo = () => makeRepo({
  'rules/rule-one.md': rule('one'),
  'rules/rule-two.md': rule('two'),
  'skills/skill-one/SKILL.md': '---\nname: skill-one\ndescription: d\n---\nbody\n',
});

const cwd = tmp('morf-global-');
const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv],
  { cwd, encoding: 'utf8', env: { ...process.env, MORF_ASCII: '1' } });
const home = rel => exists(m.home, rel);
const createdDirs = async () => (await m.readManifest()).createdDirs;

test('global: a directory morf created goes when its last item is uninstalled', async () => {
  const r = repo();
  assert.ok(!home('.claude/rules'));
  assert.equal(cli('install', r.dir, '--target', 'claude', '--rule', 'rule-one', '--rule', 'rule-two').status, 0);
  assert.ok(home('.claude/rules/rule-one.md') && home('.claude/rules/rule-two.md'));

  // One item left: the directory stays.
  assert.equal(cli('uninstall', '--rule', 'rule-one', '--target', 'claude', '-y').status, 0);
  assert.ok(home('.claude/rules/rule-two.md'));

  // The last one: the directory goes, and so does .claude, which morf also made.
  assert.equal(cli('uninstall', '--rule', 'rule-two', '--target', 'claude', '-y').status, 0);
  assert.ok(!home('.claude/rules'), 'the empty directory was left behind');
  assert.ok(!home('.claude'));
  assert.equal(await createdDirs(), undefined);
});

test('global: a directory that existed before is never removed', async () => {
  const r = repo();
  mkdirSync(join(m.home, '.claude', 'rules'), { recursive: true });
  assert.equal(cli('install', r.dir, '--target', 'claude', '--rule', 'rule-one', '--skill', 'skill-one').status, 0);
  assert.ok(home('.claude/rules/rule-one.md') && home('.claude/skills/skill-one/SKILL.md'));
  assert.equal(cli('uninstall', '--all', '--target', 'claude', '-y').status, 0);
  assert.ok(home('.claude/rules'), 'a directory morf did not create was removed');
  assert.ok(!home('.claude/skills'), 'morf created skills/, so it goes');
  assert.ok(home('.claude'));
});

test('global: a created directory that still holds someone else\'s file stays', async () => {
  const r = repo();
  cli('uninstall', '--all', '-y');
  assert.equal(cli('install', r.dir, '--target', 'claude', '--skill', 'skill-one').status, 0);
  assert.ok(home('.claude/skills/skill-one/SKILL.md'));
  write(m.home, '.claude/skills/mine/SKILL.md', 'my own skill\n');
  assert.equal(cli('uninstall', '--all', '--target', 'claude', '-y').status, 0);
  assert.ok(home('.claude/skills/mine/SKILL.md'));
  assert.ok(!home('.claude/skills/skill-one'));
});

test('project mode: the same, inside the project', async () => {
  const r = repo();
  const root = await newProject();
  mkdirSync(join(root, '.claude'));              // the project already has .claude/
  assert.equal((await install(root, r, { names: names({ rule: ['rule-one'], skill: ['skill-one'] }) })).code, 0);
  assert.ok(exists(root, '.claude/rules/rule-one.md') && exists(root, '.claude/skills/skill-one/SKILL.md'));
  const res = await run(() => m.projectUninstallCommand({ names: NAMES(), all: true, targets: [], yes: true }, ctx(root)));
  assert.equal(res.code, 0, res.out);
  assert.ok(!exists(root, '.claude/rules') && !exists(root, '.claude/skills'));
  assert.ok(exists(root, '.claude'), 'a directory that existed before was removed');
});
