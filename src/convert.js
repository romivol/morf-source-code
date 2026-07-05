// Bidirectional tools format conversion and OpenCode field sanitization for agent files.
// No external YAML library — frontmatter is parsed manually.

// Targets that use the OpenCode agent format (boolean-map tools, same field rules).
// kilo v7 is built on the OpenCode server, so it shares the same wire format.
const OC_LIKE = new Set(['opencode', 'kilo']);

// ── Tool name mapping ─────────────────────────────────────────────────────────

// [claudeName, opencodeName] — LS and List both map to 'list'; on reverse, last wins → 'List'.
const TOOL_PAIRS = [
  ['Read',      'read'],
  ['Write',     'write'],
  ['Edit',      'edit'],
  ['Bash',      'bash'],
  ['Glob',      'glob'],
  ['Grep',      'grep'],
  ['Task',      'task'],
  ['WebFetch',  'webfetch'],
  ['TodoWrite', 'todowrite'],
  ['TodoRead',  'todoread'],
  ['LS',        'list'],
  ['List',      'list'],
];

const CLAUDE_TO_OC = new Map(TOOL_PAIRS.map(([c, oc]) => [c.toLowerCase(), oc]));
const OC_TO_CLAUDE = new Map(TOOL_PAIRS.map(([c, oc]) => [oc, c]));

// ── Shared frontmatter helpers ────────────────────────────────────────────────

// Splits a file into its frontmatter parts. Returns null if no frontmatter block.
function parseFrontmatter(fileText) {
  const m = fileText.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return null;
  const fmContent = m[1];
  return {
    fmLines:     fmContent.split(/\r?\n/),
    lineEnding:  fmContent.includes('\r\n') ? '\r\n' : '\n',
    trailingSep: m[2],               // '' | '\n' | '\r\n'
    body:        fileText.slice(m[0].length),
  };
}

function assembleFrontmatter(fmLines, lineEnding, trailingSep, body) {
  return `---${lineEnding}${fmLines.join(lineEnding)}${lineEnding}---${trailingSep}${body}`;
}

// ── Tools conversion ──────────────────────────────────────────────────────────

// Returns { text, changed }.
// On any parse error, falls back to { text: fileText, changed: false }.
export function convertAgentTools(fileText, targetFormat) {
  try {
    return _convertTools(fileText, targetFormat);
  } catch {
    return { text: fileText, changed: false };
  }
}

function _convertTools(fileText, targetFormat) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return { text: fileText, changed: false };

  const { fmLines, lineEnding, trailingSep, body } = parsed;

  // Find 'tools:' key (must be at column 0)
  let toolsIdx = -1;
  for (let i = 0; i < fmLines.length; i++) {
    if (/^tools\s*:/i.test(fmLines[i])) { toolsIdx = i; break; }
  }
  if (toolsIdx === -1) return { text: fileText, changed: false };

  const colonPos = fmLines[toolsIdx].indexOf(':');
  const afterColon = fmLines[toolsIdx].slice(colonPos + 1).trimStart();
  const isBlock = afterColon === '';

  // Find the last line of the tools block
  let toolsEndIdx = toolsIdx;
  if (isBlock) {
    for (let i = toolsIdx + 1; i < fmLines.length; i++) {
      if (/^[ \t]+\S/.test(fmLines[i])) toolsEndIdx = i;
      else if (fmLines[i].trim() === '') continue;
      else break;
    }
  }

  // Determine current format: opencode map vs claude string/list
  let isOpenCodeFormat;
  if (!isBlock) {
    // Inline map `{key: val}` is opencode; anything else is claude
    isOpenCodeFormat = afterColon.trim().startsWith('{');
  } else {
    const subLines = fmLines.slice(toolsIdx + 1, toolsEndIdx + 1);
    if (subLines.length === 0) return { text: fileText, changed: false };
    const first = subLines[0].trimStart();
    // Block list starts with '-'; block map has 'key: value'
    isOpenCodeFormat = !first.startsWith('-') && /^[\w-]+\s*:/.test(first);
  }

  if (OC_LIKE.has(targetFormat) && isOpenCodeFormat) return { text: fileText, changed: false };
  if (!OC_LIKE.has(targetFormat) && !isOpenCodeFormat) return { text: fileText, changed: false };

  let newToolsLines;

  if (OC_LIKE.has(targetFormat)) {
    // Parse claude tool names (string or list form)
    let toolNames;
    if (!isBlock) {
      let v = afterColon.trim();
      if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
      toolNames = v.split(',').map(t => t.trim()).filter(Boolean);
    } else {
      toolNames = fmLines.slice(toolsIdx + 1, toolsEndIdx + 1)
        .map(l => l.trimStart().replace(/^-\s*/, '').trim())
        .filter(Boolean);
    }
    const map = {};
    for (const name of toolNames) {
      const oc = CLAUDE_TO_OC.get(name.toLowerCase());
      if (oc !== undefined) map[oc] = true;
    }
    if (Object.keys(map).length === 0) return { text: fileText, changed: false };
    newToolsLines = ['tools:', ...Object.entries(map).map(([k]) => `  ${k}: true`)];
  } else {
    // Parse opencode map -> claude string
    const subLines = fmLines.slice(toolsIdx + 1, toolsEndIdx + 1);
    const names = [];
    for (const line of subLines) {
      const m = line.trimStart().match(/^([\w-]+)\s*:\s*(\S+)/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].toLowerCase();
      if (val === 'false' || val === '0') continue;
      const claudeName = OC_TO_CLAUDE.get(key);
      if (claudeName !== undefined) names.push(claudeName);
    }
    if (names.length === 0) return { text: fileText, changed: false };
    newToolsLines = [`tools: ${names.join(', ')}`];
  }

  const newFmLines = [
    ...fmLines.slice(0, toolsIdx),
    ...newToolsLines,
    ...fmLines.slice(toolsEndIdx + 1),
  ];

  return { text: assembleFrontmatter(newFmLines, lineEnding, trailingSep, body), changed: true };
}

// ── OpenCode field validation ─────────────────────────────────────────────────

function unquote(v) {
  const t = v.trim();
  if (t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

const OC_THEME_COLORS = new Set(['primary','secondary','accent','success','warning','error','info']);

// Fields checked when targeting opencode. validate(inlineValue) → true means keep, false → comment out.
// permission.validate is always false (unconditionally comment out).
const OC_FIELD_RULES = {
  color: {
    validate: v => /^#[0-9a-fA-F]{6}$/i.test(v.trim()) || OC_THEME_COLORS.has(v.trim().toLowerCase()),
    reason: 'opencode needs a hex or theme color',
  },
  model: {
    validate: v => v.trim().includes('/'),
    reason: 'opencode needs provider/model-id',
  },
  temperature: {
    validate: v => { const n = Number(v.trim()); return !isNaN(n) && isFinite(n) && n >= 0 && n <= 1; },
    reason: 'opencode needs a number 0.0–1.0',
  },
  permission: {
    validate: () => false,
    reason: 'not supported in opencode agent frontmatter',
  },
};

// Returns { text, changed, fields } where fields is the list of commented field names.
export function commentInvalidOpencodeFields(fileText) {
  try {
    return _commentFields(fileText);
  } catch {
    return { text: fileText, changed: false, fields: [] };
  }
}

function _commentFields(fileText) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return { text: fileText, changed: false, fields: [] };

  const { fmLines, lineEnding, trailingSep, body } = parsed;
  const result = [...fmLines];
  const commentedFields = [];

  for (let i = 0; i < result.length; i++) {
    // Only match top-level (non-indented) keys
    const m = result[i].match(/^([\w-]+)\s*:(.*)/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const rule = OC_FIELD_RULES[key];
    if (!rule) continue;

    const afterColon = m[2].trimStart();
    const isBlock = afterColon === '';

    // Find extent of any indented block children
    let endIdx = i;
    if (isBlock) {
      for (let j = i + 1; j < result.length; j++) {
        if (/^[ \t]+\S/.test(result[j])) endIdx = j;
        else if (result[j].trim() === '') continue;
        else break;
      }
    }

    // Block values can't satisfy color/model/temperature rules — always comment them.
    const shouldComment = isBlock ? true : !rule.validate(unquote(afterColon));
    if (!shouldComment) continue;

    // Prefix the key line with `# ` and append the reason.
    result[i] = `# ${result[i]}   (commented by morf: ${rule.reason})`;
    // Prefix any block children with `# `.
    for (let j = i + 1; j <= endIdx; j++) {
      result[j] = `# ${result[j]}`;
    }

    commentedFields.push(key);
    i = endIdx; // skip past block children
  }

  if (commentedFields.length === 0) return { text: fileText, changed: false, fields: [] };

  return {
    text: assembleFrontmatter(result, lineEnding, trailingSep, body),
    changed: true,
    fields: commentedFields,
  };
}

// ── Frontmatter field reader (used by list for display) ───────────────────────

// Parse frontmatter and extract display fields. Tolerates any unknown keys.
// filenameBase is used as the name fallback when 'name:' is absent.
// Returns { name, description, mode, color, permission } — all optional except name.
export function parseAgentFrontmatter(fileText, filenameBase = '') {
  try {
    return _parseAgentFrontmatter(fileText, filenameBase);
  } catch {
    return { name: filenameBase || '' };
  }
}

function _parseAgentFrontmatter(fileText, filenameBase) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return { name: filenameBase || '' };

  const { fmLines } = parsed;
  const fields = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    const m = line.match(/^([\w-]+)\s*:(.*)/);
    if (!m) { i++; continue; }

    const key = m[1];
    const rest = m[2].trimStart();

    if (rest === '') {
      // Block value — collect indented children as raw text
      const children = [];
      let j = i + 1;
      while (j < fmLines.length && /^[ \t]+\S/.test(fmLines[j])) {
        children.push(fmLines[j]);
        j++;
      }
      fields[key] = children.join('\n');
      i = j;
    } else {
      fields[key] = rest;
      i++;
    }
  }

  return {
    name:        fields.name        || filenameBase || '',
    description: fields.description || '',
    mode:        fields.mode        || '',
    color:       fields.color       || '',
    permission:  fields.permission  || '',
  };
}

// ── Per-target field rules for project-scope tools ───────────────────────────

// Cursor rules (.mdc) understand: description, globs, alwaysApply.
// Copilot agents (.github/agents/*.md) understand: description (name from filename).
// Windsurf/Devin rules understand: description, globs, trigger.
// Fields outside each allow-list are commented out (never dropped — the user
// can uncomment if their tool version supports more).
const TARGET_FIELD_ALLOW = {
  cursor:   new Set(['description', 'globs', 'alwaysapply']),
  copilot:  new Set(['description']),
  windsurf: new Set(['description', 'globs', 'trigger']),
};

// Comment out any top-level frontmatter field not in the allow-list.
// Returns { text, changed, fields }.
export function commentFieldsForTarget(fileText, target) {
  const allow = TARGET_FIELD_ALLOW[target];
  if (!allow) return { text: fileText, changed: false, fields: [] };
  try {
    return _commentDisallowed(fileText, allow, target);
  } catch {
    return { text: fileText, changed: false, fields: [] };
  }
}

function _commentDisallowed(fileText, allow, target) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return { text: fileText, changed: false, fields: [] };

  const { fmLines, lineEnding, trailingSep, body } = parsed;
  const result = [...fmLines];
  const commentedFields = [];

  for (let i = 0; i < result.length; i++) {
    const m = result[i].match(/^([\w-]+)\s*:(.*)/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (allow.has(key)) continue;

    const afterColon = m[2].trimStart();
    const isBlock = afterColon === '';
    let endIdx = i;
    if (isBlock) {
      for (let j = i + 1; j < result.length; j++) {
        if (/^[ \t]+\S/.test(result[j])) endIdx = j;
        else if (result[j].trim() === '') continue;
        else break;
      }
    }

    result[i] = `# ${result[i]}   (commented by morf: not supported in ${target})`;
    for (let j = i + 1; j <= endIdx; j++) result[j] = `# ${result[j]}`;
    commentedFields.push(key);
    i = endIdx;
  }

  if (commentedFields.length === 0) return { text: fileText, changed: false, fields: [] };
  return {
    text: assembleFrontmatter(result, lineEnding, trailingSep, body),
    changed: true,
    fields: commentedFields,
  };
}

// Ensure a frontmatter key exists with the given inline value (adds after '---' if missing).
function ensureField(fileText, key, value) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return { text: fileText, changed: false };
  const { fmLines, lineEnding, trailingSep, body } = parsed;
  const re = new RegExp('^' + key + '\\s*:', 'i');
  if (fmLines.some(l => re.test(l))) return { text: fileText, changed: false };
  const newLines = [...fmLines, `${key}: ${value}`];
  return { text: assembleFrontmatter(newLines, lineEnding, trailingSep, body), changed: true };
}

// ── Combined adapter (entry point for install.js) ─────────────────────────────

// Adapts an agent file for the given target. Returns { text, changed, notes }.
// - claude / opencode / kilo: tools-format conversion + OC field validation (existing behavior)
// - cursor: comment non-rule fields, add alwaysApply: false -> .mdc rule
// - copilot / windsurf: comment unsupported fields
export function adaptAgentForTarget(fileText, targetFormat) {
  try {
    return _adapt(fileText, targetFormat);
  } catch {
    return { text: fileText, changed: false, notes: [] };
  }
}

function _adapt(fileText, targetFormat) {
  // Project-scope targets: allow-list based commenting.
  if (TARGET_FIELD_ALLOW[targetFormat]) {
    let text = fileText;
    const notes = [];
    let changed = false;

    const { text: t1, changed: c1, fields } = commentFieldsForTarget(text, targetFormat);
    text = t1;
    if (c1) { changed = true; notes.push(`commented ${fields.join(', ')}`); }

    if (targetFormat === 'cursor') {
      const { text: t2, changed: c2 } = ensureField(text, 'alwaysApply', 'false');
      text = t2;
      if (c2) { changed = true; notes.push('added alwaysApply'); }
    }

    return { text, changed, notes };
  }

  // Global targets: existing tools conversion + OC validation.
  const { text: afterTools, changed: toolsChanged } = convertAgentTools(fileText, targetFormat);

  let finalText = afterTools;
  let fieldsChanged = false;
  const commentedFields = [];

  if (OC_LIKE.has(targetFormat)) {
    const { text: afterFields, changed: fc, fields } = commentInvalidOpencodeFields(afterTools);
    finalText = afterFields;
    fieldsChanged = fc;
    commentedFields.push(...fields);
  }

  const changed = toolsChanged || fieldsChanged;
  const notes = [];
  if (toolsChanged) notes.push('tools');
  if (commentedFields.length > 0) notes.push(`commented ${commentedFields.join(', ')}`);

  return { text: finalText, changed, notes };
}
