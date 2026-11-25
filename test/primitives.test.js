import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertRule, convertPrompt, convertHook, convertMcp, normalizeMcp } from '../src/primitives.js';

const rule = `---
description: TypeScript conventions
globs: src/**/*.ts, src/**/*.{tsx,mts}
alwaysApply: false
---
- Use named exports
`;

test('convertRule(claude) turns globs into a paths list', () => {
  const { text } = convertRule(rule, 'claude');
  assert.match(text, /^paths:\n {2}- "src\/\*\*\/\*\.ts"\n {2}- "src\/\*\*\/\*\.\{tsx,mts\}"$/m);
  assert.doesNotMatch(text, /globs|alwaysApply/);
});

test('convertRule(cursor) keeps globs comma-separated and sets alwaysApply', () => {
  const { text } = convertRule(rule, 'cursor');
  assert.match(text, /^globs: src\/\*\*\/\*\.ts,src\/\*\*\/\*\.\{tsx,mts\}$/m);
  assert.match(text, /^alwaysApply: false$/m);
});

test('convertRule(cursor) makes a rule with no frontmatter always apply', () => {
  const { text } = convertRule('Always write tests.\n', 'cursor');
  assert.equal(text, '---\nalwaysApply: true\n---\nAlways write tests.\n');
});

test('convertRule(copilot) writes applyTo, defaulting to every file', () => {
  assert.match(convertRule(rule, 'copilot').text, /^applyTo: "src\/\*\*\/\*\.ts,src\/\*\*\/\*\.\{tsx,mts\}"$/m);
  assert.match(convertRule('Always.\n', 'copilot').text, /^applyTo: "\*\*"$/m);
});

test('convertRule(windsurf) derives the trigger', () => {
  assert.match(convertRule(rule, 'windsurf').text, /^trigger: glob$/m);
  assert.match(convertRule('Always.\n', 'windsurf').text, /^trigger: always_on$/m);
  assert.match(convertRule('---\ndescription: when asked\n---\nx\n', 'windsurf').text, /^trigger: model_decision$/m);
});

test('convertRule(opencode/codex) emits plain instructions and notes the lost scoping', () => {
  const oc = convertRule(rule, 'opencode');
  assert.doesNotMatch(oc.text, /^---/);
  assert.match(oc.text, /^Applies to: `src\/\*\*\/\*\.ts`/);
  assert.ok(oc.notes.includes('no glob scoping'));
  assert.match(convertRule(rule, 'codex', { name: 'ts-style' }).text, /^## ts-style\n/);
});

const prompt = `---
description: Fix a GitHub issue
argument-hint: [issue-number]
allowed-tools: Bash(gh:*), Read
model: sonnet
---
Fix issue $ARGUMENTS, then $1.
`;

test('convertPrompt(claude) is the identity', () => {
  assert.equal(convertPrompt(prompt, 'claude').text, prompt);
});

test('convertPrompt(cursor) strips frontmatter', () => {
  assert.equal(convertPrompt(prompt, 'cursor').text, 'Fix issue $ARGUMENTS, then $1.\n');
});

test('convertPrompt(opencode) keeps description and comments the rest', () => {
  const { text } = convertPrompt(prompt, 'opencode');
  assert.match(text, /^description: Fix a GitHub issue$/m);
  assert.match(text, /^# model: sonnet/m);
  assert.match(text, /^# allowed-tools:/m);
  assert.match(text, /\$ARGUMENTS/);
});

test('convertPrompt(copilot) maps arguments to input variables', () => {
  const { text, notes } = convertPrompt(prompt, 'copilot');
  assert.match(text, /Fix issue \$\{input:arguments\}, then \$\{input:arg1\}\./);
  assert.match(text, /^argument-hint: \[issue-number\]$/m);
  assert.ok(notes.includes('arguments mapped'));
});

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

const stdio = { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: '${API_KEY}', MODE: 'fast' } };
const remote = { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Region': 'us' } };

test('normalizeMcp accepts an OpenCode-style command array', () => {
  const s = normalizeMcp({ type: 'local', command: ['npx', '-y', 'pkg'], environment: { A: '1' } });
  assert.deepEqual(s, { remote: false, command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });
});

test('convertMcp(opencode) uses a command array and {env:VAR}', () => {
  assert.deepEqual(convertMcp(stdio, 'opencode').value, {
    type: 'local', command: ['npx', '-y', 'pkg'], environment: { API_KEY: '{env:API_KEY}', MODE: 'fast' }, enabled: true,
  });
  assert.equal(convertMcp(remote, 'kilo').value.headers.Authorization, 'Bearer {env:TOKEN}');
});

test('convertMcp(cursor/windsurf) use ${env:VAR}', () => {
  assert.equal(convertMcp(stdio, 'cursor').value.env.API_KEY, '${env:API_KEY}');
  assert.equal(convertMcp(stdio, 'cursor').value.type, 'stdio');
  assert.deepEqual(convertMcp(remote, 'windsurf').value,
    { url: 'https://x/mcp', transport: 'http', headers: { Authorization: 'Bearer ${env:TOKEN}', 'X-Region': 'us' } });
});

test('convertMcp(claude/copilot) keep ${VAR}', () => {
  assert.deepEqual(convertMcp(stdio, 'claude').value, stdio);
  assert.deepEqual(convertMcp(remote, 'copilot').value, { ...remote, tools: ['*'] });
});

test('convertMcp(codex) renders a TOML table', () => {
  const s = convertMcp(stdio, 'codex', { name: 'ctx' }).text;
  assert.match(s, /^\[mcp_servers\.ctx\]\ncommand = "npx"\nargs = \["-y", "pkg"\]\nenv_vars = \["API_KEY"\]\n\n\[mcp_servers\.ctx\.env\]\nMODE = "fast"\n$/);
  const r = convertMcp(remote, 'codex', { name: 'fig' }).text;
  assert.match(r, /^bearer_token_env_var = "TOKEN"$/m);
  assert.match(r, /^http_headers = \{ X-Region = "us" \}$/m);
});
