import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  listTargets,
  expandTargets,
  targetScope,
  isValidTarget,
  resolveDestination,
  detectTargets,
} from '../../src/install/targets.js';

test('listTargets includes codex and totals 7', () => {
  const targets = listTargets();
  assert.ok(targets.includes('codex'));
  assert.equal(targets.length, 7);
});

test("expandTargets('all') returns all 7 targets", () => {
  assert.equal(expandTargets('all').length, 7);
});

test('codex is a valid, global-scope target', () => {
  assert.ok(isValidTarget('codex'));
  assert.equal(targetScope('codex'), 'global');
});

test('codex skill destination is ~/.codex/skills', () => {
  assert.equal(
    resolveDestination('codex', 'skill').base,
    join(homedir(), '.codex', 'skills')
  );
});

test('codex agents are TOML files under ~/.codex/agents', () => {
  const m = resolveDestination('codex', 'agent');
  assert.equal(m.base, join(homedir(), '.codex', 'agents'));
  assert.equal(m.ext, '.toml');
});

test('every target has a destination for every primitive', () => {
  for (const target of listTargets()) {
    for (const type of ['skill', 'agent', 'rule', 'prompt', 'hook', 'mcp']) {
      assert.ok(resolveDestination(target, type).kind, `${target}/${type}`);
    }
  }
});

test('project-scope destinations follow the given cwd', () => {
  const cwd = join(homedir(), 'some-project');
  assert.equal(resolveDestination('cursor', 'rule', cwd).base, join(cwd, '.cursor', 'rules'));
  assert.equal(resolveDestination('cursor', 'agent', cwd).base, join(cwd, '.cursor', 'agents'));
  assert.equal(resolveDestination('copilot', 'mcp', cwd).file, join(cwd, '.mcp.json'));
  assert.equal(resolveDestination('windsurf', 'hook', cwd).file, join(cwd, '.devin', 'hooks.v1.json'));
});

test('detectTargets only reports project tools with a marker in the project', () => {
  const empty = join(homedir(), 'morf-no-such-project-dir');
  const detected = detectTargets(empty);
  for (const t of ['cursor', 'copilot', 'windsurf']) assert.ok(!detected.includes(t));
});
