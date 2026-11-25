import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertHook } from '../../src/convert/hooks.js';

const hooks = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh', timeout: 10 }] }],
  PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt' }, { type: 'prompt', prompt: 'x' }] }],
  Notification: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
};

test('convertHook(claude) passes the source through', () => {
  assert.deepEqual(convertHook(hooks, 'claude').value, hooks);
});

test('convertHook(cursor) flattens entries, maps events and tool names', () => {
  const { value, notes } = convertHook(hooks, 'cursor');
  assert.deepEqual(value.preToolUse, [{ command: './check.sh', matcher: 'Shell', timeout: 10 }]);
  assert.deepEqual(value.postToolUse, [{ command: 'fmt', matcher: 'Write' }]);
  assert.equal(value.notification, undefined);
  assert.ok(notes.some(n => n.includes('dropped Notification')));
  assert.ok(notes.some(n => n.includes('non-command')));
});

test('convertHook(copilot) emits a versioned hooks file', () => {
  const { text } = convertHook(hooks, 'copilot');
  const file = JSON.parse(text);
  assert.equal(file.version, 1);
  assert.deepEqual(file.hooks.preToolUse, [{ type: 'command', command: './check.sh', matcher: 'Bash', timeoutSec: 10 }]);
  assert.ok(file.hooks.notification);
});

test('convertHook(windsurf) keeps matcher groups with Devin tool names', () => {
  const { value } = convertHook(hooks, 'windsurf');
  assert.equal(value.PreToolUse[0].matcher, 'exec');
  assert.equal(value.PostToolUse[0].matcher, 'edit|write');
  assert.deepEqual(value.PreToolUse[0].hooks, [{ type: 'command', command: './check.sh', timeout: 10 }]);
});

test('convertHook(opencode) generates a plugin with a single named export', () => {
  const { text, notes } = convertHook(hooks, 'opencode', { name: 'guard' });
  assert.match(text, /export const MorfHook_guard = async/);
  assert.equal(text.match(/^export /gm).length, 1);
  assert.match(text, /"tool\.execute\.before"/);
  assert.match(text, /"tool\.execute\.after"/);
  assert.ok(notes.includes('generated plugin'));
});

test('convertHook reports unsupported when no event maps', () => {
  const res = convertHook({ Notification: hooks.Notification }, 'windsurf');
  assert.match(res.unsupported, /Notification/);
});
