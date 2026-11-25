import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertRule } from '../../src/convert/rules.js';

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
