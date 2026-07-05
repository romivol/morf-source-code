import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAgentTools,
  commentInvalidOpencodeFields,
  parseAgentFrontmatter,
  adaptAgentForTarget,
} from '../src/convert.js';

const claudeAgent = `---
name: demo
tools: Read, Write, Bash
---
body text
`;

const opencodeAgent = `---
name: demo
tools:
  read: true
  write: true
---
body text
`;

test('convertAgentTools: claude list -> opencode boolean map', () => {
  const { text, changed } = convertAgentTools(claudeAgent, 'opencode');
  assert.equal(changed, true);
  assert.match(text, /tools:/);
  assert.match(text, /read: true/);
  assert.match(text, /write: true/);
  assert.match(text, /bash: true/);
});

test('convertAgentTools: opencode map -> claude comma list', () => {
  const { text, changed } = convertAgentTools(opencodeAgent, 'claude');
  assert.equal(changed, true);
  assert.match(text, /tools: Read, Write/);
});

test('convertAgentTools: no-op when already in the target format', () => {
  const { changed } = convertAgentTools(opencodeAgent, 'opencode');
  assert.equal(changed, false);
});

test('convertAgentTools: malformed input degrades to no-op', () => {
  const { text, changed } = convertAgentTools('no frontmatter here', 'opencode');
  assert.equal(changed, false);
  assert.equal(text, 'no frontmatter here');
});

test('commentInvalidOpencodeFields comments invalid model/permission', () => {
  const input = `---
name: demo
model: gpt-4
permission:
  edit: allow
---
body
`;
  const { text, changed, fields } = commentInvalidOpencodeFields(input);
  assert.equal(changed, true);
  assert.ok(fields.includes('model'));
  assert.ok(fields.includes('permission'));
  assert.match(text, /# model: gpt-4/);
});

test('commentInvalidOpencodeFields keeps a valid provider/model', () => {
  const input = `---
name: demo
model: anthropic/claude-sonnet-4
---
body
`;
  const { changed } = commentInvalidOpencodeFields(input);
  assert.equal(changed, false);
});

test('parseAgentFrontmatter extracts fields with filename fallback', () => {
  const meta = parseAgentFrontmatter(claudeAgent, 'fallback');
  assert.equal(meta.name, 'demo');
  const noName = parseAgentFrontmatter('---\ndescription: x\n---\nbody', 'fallback');
  assert.equal(noName.name, 'fallback');
});

test('adaptAgentForTarget(cursor) comments non-rule fields and adds alwaysApply', () => {
  const { text, changed, notes } = adaptAgentForTarget(claudeAgent, 'cursor');
  assert.equal(changed, true);
  assert.match(text, /alwaysApply: false/);
  assert.ok(notes.some(n => n.includes('alwaysApply')));
});
