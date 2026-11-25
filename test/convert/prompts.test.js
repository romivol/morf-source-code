import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertPrompt } from '../../src/convert/prompts.js';

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
