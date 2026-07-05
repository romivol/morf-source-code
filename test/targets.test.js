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
} from '../src/targets.js';

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

test('codex does not support agents', () => {
  assert.throws(
    () => resolveDestination('codex', 'agent'),
    /does not support agents/
  );
});
