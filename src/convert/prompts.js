// Prompt (custom slash command) conversion.
//
// The source format is the Claude Code one (the same convention morf uses for
// agents); the converter reshapes it for one target tool.
//
//   convertPrompt -> { text, notes }

import { stripFrontmatter, getScalar, commentField } from './frontmatter.js';
import { OC_LIKE, commentOthers, isClaudeOnlyModel } from './shared.js';

// Source: Claude Code command — frontmatter description, argument-hint,
// allowed-tools, model; body uses $ARGUMENTS / $1.

const PROMPT_FIELDS = {
  opencode: new Set(['description', 'agent', 'model', 'subtask', 'variant']),
  kilo:     new Set(['description', 'agent', 'model', 'subtask', 'variant']),
  copilot:  new Set(['name', 'description', 'argument-hint', 'agent', 'model', 'tools']),
  windsurf: new Set(['title', 'description']),
  codex:    new Set(['description', 'argument-hint']),
};

export function convertPrompt(sourceText, target) {
  const notes = [];
  if (target === 'claude') return { text: sourceText, notes };

  // Cursor commands are plain Markdown: frontmatter would be sent as prompt text.
  if (target === 'cursor') {
    const text = stripFrontmatter(sourceText);
    if (text !== sourceText) notes.push('frontmatter removed');
    return { text, notes };
  }

  let text = sourceText;
  const model = getScalar(text, 'model');
  if (model !== null) {
    const bad = OC_LIKE.has(target) ? !model.includes('/') : isClaudeOnlyModel(model);
    if (bad) {
      const reason = OC_LIKE.has(target) ? `${target} needs provider/model-id` : `"${model}" is a Claude Code model alias`;
      const res = commentField(text, 'model', reason);
      text = res.text;
      if (res.changed) notes.push('commented model');
    }
  }

  if (target === 'copilot') {
    // Copilot prompt files take arguments as ${input:name} variables.
    const replaced = text
      .replace(/\$ARGUMENTS\b/g, '${input:arguments}')
      .replace(/(?<![\w$])\$([1-9])\b/g, '${input:arg$1}');
    if (replaced !== text) { text = replaced; notes.push('arguments mapped'); }
  }

  text = commentOthers(text, PROMPT_FIELDS[target], target, notes);
  return { text, notes };
}
