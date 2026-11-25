// Rule conversion.
//
// The source format is the Claude Code one (the same convention morf uses for
// agents); the converter reshapes it for one target tool.
//
//   convertRule -> { text, notes }

import { parseFrontmatter, stripFrontmatter, getScalar, getList, setField, removeField, yamlString } from './frontmatter.js';
import { OC_LIKE, commentOthers } from './shared.js';

// Drop a frontmatter block that ended up with no fields.
function dropEmptyFrontmatter(text) {
  const parsed = parseFrontmatter(text);
  if (parsed && parsed.fmLines.every(l => l.trim() === '')) return stripFrontmatter(text);
  return text;
}

// Source frontmatter (all optional): description, globs | paths | applyTo,
// alwaysApply, trigger.

const RULE_SOURCE_FIELDS = ['globs', 'paths', 'applyTo', 'alwaysApply', 'trigger'];

const RULE_FIELDS = {
  claude:   new Set(['paths', 'description']),
  cursor:   new Set(['description', 'globs', 'alwaysapply']),
  copilot:  new Set(['applyto', 'name', 'description', 'excludeagent']),
  windsurf: new Set(['trigger', 'globs', 'description']),
};

const WINDSURF_TRIGGERS = new Set(['always_on', 'glob', 'model_decision', 'manual']);

export function convertRule(sourceText, target, { name = 'rule' } = {}) {
  const notes = [];
  const globs = [...new Set([
    ...getList(sourceText, 'globs'),
    ...getList(sourceText, 'paths'),
    ...getList(sourceText, 'applyTo'),
  ])].filter(g => g !== '**' && g !== '**/*');
  const sourceTrigger = (getScalar(sourceText, 'trigger') || '').toLowerCase();
  const always = (getScalar(sourceText, 'alwaysApply') || '').toLowerCase() === 'true' ||
    sourceTrigger === 'always_on';
  const description = getScalar(sourceText, 'description');
  const scoped = globs.length > 0 && !always;

  // Tools without rule files: the rule is plain instructions text.
  if (OC_LIKE.has(target) || target === 'codex') {
    let body = stripFrontmatter(sourceText).replace(/\s+$/, '');
    if (scoped) {
      body = `Applies to: ${globs.map(g => '`' + g + '`').join(', ')}\n\n${body}`;
      notes.push('no glob scoping');
    }
    if (target === 'codex') body = `## ${name}\n\n${body}`;
    return { text: body + '\n', notes };
  }

  let text = sourceText;
  for (const key of RULE_SOURCE_FIELDS) text = removeField(text, key);

  if (target === 'claude') {
    if (scoped) text = setField(text, 'paths', globs.map(g => `  - ${JSON.stringify(g)}`));
  } else if (target === 'cursor') {
    if (globs.length > 0) text = setField(text, 'globs', globs.join(','));
    text = setField(text, 'alwaysApply', String(always || (globs.length === 0 && !description)));
  } else if (target === 'copilot') {
    text = setField(text, 'applyTo', JSON.stringify(scoped ? globs.join(',') : '**'));
  } else if (target === 'windsurf') {
    let trigger;
    if (always) trigger = 'always_on';
    else if (globs.length > 0) trigger = 'glob';
    else if (WINDSURF_TRIGGERS.has(sourceTrigger)) trigger = sourceTrigger;
    else trigger = description ? 'model_decision' : 'always_on';
    text = setField(text, 'trigger', trigger);
    if (trigger === 'glob') text = setField(text, 'globs', yamlString(globs.join(',')));
  }

  if (RULE_FIELDS[target]) text = commentOthers(text, RULE_FIELDS[target], target, notes);
  text = dropEmptyFrontmatter(text);
  if (text !== sourceText && notes.length === 0) notes.push('frontmatter');
  return { text, notes };
}
