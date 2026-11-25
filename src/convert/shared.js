// Small pieces the converters share.

import { commentFieldsExcept } from './frontmatter.js';

// Targets that use the OpenCode formats. Kilo v7 is built on the OpenCode
// server, so it shares them.
export const OC_LIKE = new Set(['opencode', 'kilo']);

// Comment out every frontmatter field the target does not understand.
export function commentOthers(text, allow, target, notes) {
  const res = commentFieldsExcept(text, allow, `not supported in ${target}`);
  if (res.changed) notes.push(`commented ${res.fields.join(', ')}`);
  return res.text;
}

// Model aliases that only mean something to Claude Code.
export function isClaudeOnlyModel(value) {
  return /^(sonnet|opus|haiku|fable|inherit)(\[.*\])?$/i.test(value) || /^claude-/i.test(value);
}
