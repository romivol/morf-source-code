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

test('commentInvalidOpencodeFields comments an invalid model but keeps permission', () => {
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
  assert.ok(!fields.includes('permission'));
  assert.match(text, /# model: gpt-4/);
  assert.match(text, /^permission:$/m);
  assert.match(text, /^ {2}edit: allow$/m);
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

test('convertAgentTools: a claude list is an allow-list (other core tools off)', () => {
  const { text } = convertAgentTools(claudeAgent, 'opencode');
  assert.match(text, /edit: false/);
  assert.match(text, /webfetch: false/);
});

test('adaptAgentForTarget(opencode) marks a converted claude agent as a subagent', () => {
  const { text, notes } = adaptAgentForTarget(claudeAgent, 'opencode');
  assert.match(text, /^mode: subagent$/m);
  assert.ok(notes.includes('added mode'));
});

test('adaptAgentForTarget(cursor) produces a native subagent', () => {
  const readOnly = '---\nname: demo\ndescription: d\ntools: Read, Grep\nmodel: sonnet\n---\nbody\n';
  const { text, changed, notes } = adaptAgentForTarget(readOnly, 'cursor');
  assert.equal(changed, true);
  assert.match(text, /^# tools: Read, Grep/m);
  assert.match(text, /^# model: sonnet/m);
  assert.match(text, /^readonly: true$/m);
  assert.ok(notes.includes('added readonly'));
  // An agent that can write is not marked readonly.
  assert.doesNotMatch(adaptAgentForTarget(claudeAgent, 'cursor').text, /readonly/);
});

test('adaptAgentForTarget(copilot) maps tools to Copilot aliases', () => {
  const { text, notes } = adaptAgentForTarget(claudeAgent, 'copilot');
  assert.match(text, /^tools: \['read', 'edit', 'execute'\]$/m);
  assert.ok(notes.includes('tools mapped'));
});

test('adaptAgentForTarget(windsurf) writes Devin allowed-tools, or a rule on legacy', () => {
  const { text } = adaptAgentForTarget(claudeAgent, 'windsurf');
  assert.match(text, /^allowed-tools: \[read, write, exec\]$/m);
  assert.doesNotMatch(text, /^tools:/m);
  const legacy = adaptAgentForTarget(claudeAgent, 'windsurf', { asRule: true });
  assert.match(legacy.text, /^# tools: Read, Write, Bash/m);
});

test('adaptAgentForTarget(codex) rewrites the agent as TOML', () => {
  const { text, changed } = adaptAgentForTarget(claudeAgent, 'codex', { name: 'fallback' });
  assert.equal(changed, true);
  assert.match(text, /^name = "demo"$/m);
  assert.match(text, /^description = "demo agent"$/m);
  assert.match(text, /developer_instructions = '''\nbody text\n'''/);
});
