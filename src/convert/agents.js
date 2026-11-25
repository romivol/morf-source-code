// Agent conversion: rewrites an agent file's frontmatter (and, for Codex, the
// whole file) into the target tool's native format.
// No external YAML library — frontmatter is handled line by line (convert/frontmatter.js).

import {
  parseFrontmatter, assembleFrontmatter, stripFrontmatter, unquote,
  getScalar, getList, getMap, hasField, setField, removeField,
  commentField, commentFieldsExcept,
} from './frontmatter.js';

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

// Tools an OpenCode-style agent has unless switched off. A Claude `tools:` list
// is an allow-list, so the ones it leaves out are written as `false`.
const OC_CORE_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'list', 'task', 'webfetch', 'todowrite'];

// Claude tool name (lowercase) -> GitHub Copilot tool alias.
const COPILOT_TOOL = {
  read: 'read', ls: 'read', list: 'read', notebookread: 'read',
  write: 'edit', edit: 'edit', multiedit: 'edit', notebookedit: 'edit',
  bash: 'execute',
  grep: 'search', glob: 'search',
  task: 'agent', agent: 'agent',
  webfetch: 'web', websearch: 'web',
  todowrite: 'todo', todoread: 'todo',
};

// Claude tool name (lowercase) -> Devin (Windsurf) tool name.
const DEVIN_TOOL = {
  read: 'read', write: 'write', edit: 'edit', multiedit: 'edit',
  bash: 'exec', grep: 'grep', glob: 'glob',
};

// Tools that can change files or run commands (used to derive Cursor's `readonly`).
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'bash']);

// ── Tools conversion (claude <-> opencode/kilo) ───────────────────────────────

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
      toolNames = v.split(',').map(t => unquote(t)).filter(Boolean);
    } else {
      toolNames = fmLines.slice(toolsIdx + 1, toolsEndIdx + 1)
        .map(l => unquote(l.trimStart().replace(/^-\s*/, '')))
        .filter(Boolean);
    }
    const map = {};
    for (const name of toolNames) {
      const oc = CLAUDE_TO_OC.get(name.toLowerCase());
      if (oc !== undefined) map[oc] = true;
    }
    if (Object.keys(map).length === 0) return { text: fileText, changed: false };
    // The source list is an allow-list: switch the other core tools off.
    for (const t of OC_CORE_TOOLS) {
      if (!(t in map)) map[t] = false;
    }
    newToolsLines = ['tools:', ...Object.entries(map).map(([k, v]) => `  ${k}: ${v}`)];
  } else {
    // Parse opencode map -> claude string
    const map = getMap(fileText, 'tools') || {};
    const names = [];
    for (const [k, v] of Object.entries(map)) {
      const val = String(v).toLowerCase();
      if (val === 'false' || val === '0') continue;
      const claudeName = OC_TO_CLAUDE.get(k.toLowerCase());
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

// Tool names an agent declares, as lowercase Claude-style names, or null when
// the agent has no `tools` field (meaning: inherits everything).
function declaredTools(fileText) {
  if (!hasField(fileText, 'tools') && !hasField(fileText, 'allowed-tools')) return null;
  const map = getMap(fileText, 'tools');
  if (map && Object.keys(map).length > 0) {
    return Object.entries(map)
      .filter(([, v]) => !['false', '0'].includes(String(v).toLowerCase()))
      .map(([k]) => (OC_TO_CLAUDE.get(k.toLowerCase()) || k).toLowerCase());
  }
  const list = getList(fileText, 'tools');
  return (list.length ? list : getList(fileText, 'allowed-tools')).map(t => t.toLowerCase());
}

// ── OpenCode field validation ─────────────────────────────────────────────────

const OC_THEME_COLORS = new Set(['primary','secondary','accent','success','warning','error','info']);

// Fields checked when targeting opencode/kilo. validate(inlineValue) → true means keep.
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
};

// Returns { text, changed, fields } where fields is the list of commented field names.
export function commentInvalidOpencodeFields(fileText) {
  try {
    let text = fileText;
    const fields = [];
    for (const [key, rule] of Object.entries(OC_FIELD_RULES)) {
      if (!hasField(text, key)) continue;
      const value = getScalar(text, key);
      // Block values can't satisfy these rules — always comment them.
      if (value !== null && rule.validate(value)) continue;
      const res = commentField(text, key, rule.reason);
      if (res.changed) { text = res.text; fields.push(key); }
    }
    return { text, changed: fields.length > 0, fields };
  } catch {
    return { text: fileText, changed: false, fields: [] };
  }
}

// ── Frontmatter field reader (used by list for display) ───────────────────────

// Parse frontmatter and extract display fields. Tolerates any unknown keys.
// filenameBase is used as the name fallback when 'name:' is absent.
// Returns { name, description, mode, color, permission } — all optional except name.
export function parseAgentFrontmatter(fileText, filenameBase = '') {
  try {
    if (!parseFrontmatter(fileText)) return { name: filenameBase || '' };
    return {
      name:        getScalar(fileText, 'name')        || filenameBase || '',
      description: getScalar(fileText, 'description') || '',
      mode:        getScalar(fileText, 'mode')        || '',
      color:       getScalar(fileText, 'color')       || '',
      permission:  getScalar(fileText, 'permission')  || '',
    };
  } catch {
    return { name: filenameBase || '' };
  }
}

// ── Per-target field allow-lists ──────────────────────────────────────────────
// Fields outside a target's allow-list are commented out (never dropped — the
// user can uncomment them if their tool version supports more).

const AGENT_FIELDS = {
  // Cursor subagents: .cursor/agents/<name>.md
  cursor: new Set(['name', 'description', 'model', 'readonly', 'is_background']),
  // Copilot custom agents: .github/agents/<name>.md
  copilot: new Set(['name', 'description', 'tools', 'model', 'target', 'user-invocable',
    'disable-model-invocation', 'mcp-servers', 'metadata', 'argument-hint', 'agents', 'handoffs', 'hooks']),
  // Devin subagents: .devin/agents/<name>.md
  windsurf: new Set(['name', 'description', 'model', 'allowed-tools', 'tools', 'max-nesting']),
};

// Legacy Windsurf (Cascade) has no agent format: the agent becomes a rule.
const WINDSURF_RULE_FIELDS = new Set(['description', 'globs', 'trigger']);

// Model aliases that only mean something to Claude Code.
function isClaudeOnlyModel(value) {
  return /^(sonnet|opus|haiku|fable|inherit)(\[.*\])?$/i.test(value) || /^claude-/i.test(value);
}

function inlineList(items) {
  return `[${items.join(', ')}]`;
}

function tomlString(s) {
  return JSON.stringify(String(s));
}

function tomlMultiline(s) {
  const body = String(s).replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  if (!body.includes("'''")) return `'''\n${body}\n'''`;
  return tomlString(body);
}

// ── Combined adapter (entry point for install) ────────────────────────────────

// Adapts an agent file for the given target. Returns { text, changed, notes }.
//
//   claude            tools map -> comma list
//   opencode / kilo   tools list -> boolean map, mode: subagent, field validation
//   cursor            native subagent: readonly derived from tools, model checked
//   copilot           tools mapped to Copilot's aliases, model checked
//   windsurf          Devin subagent: allowed-tools mapped (or a rule on legacy .windsurf/)
//   codex             rewritten as a TOML custom agent
//
// options: { name: fallback agent name (the file name), asRule: legacy windsurf }
export function adaptAgentForTarget(fileText, targetFormat, options = {}) {
  try {
    return _adapt(fileText, targetFormat, options);
  } catch {
    return { text: fileText, changed: false, notes: [] };
  }
}

function _adapt(fileText, target, options) {
  if (target === 'codex') return adaptForCodex(fileText, options);
  if (target === 'cursor') return adaptForCursor(fileText);
  if (target === 'copilot') return adaptForCopilot(fileText);
  if (target === 'windsurf') return options.asRule ? adaptAsWindsurfRule(fileText) : adaptForDevin(fileText);

  // claude / opencode / kilo: tools conversion + OC validation.
  const notes = [];
  let { text, changed } = convertAgentTools(fileText, target);
  if (changed) notes.push('tools');

  if (OC_LIKE.has(target)) {
    // A converted Claude agent is a subagent; OpenCode would default it to "all".
    if (changed && !hasField(text, 'mode')) {
      text = setField(text, 'mode', 'subagent');
      notes.push('added mode');
    }
    const res = commentInvalidOpencodeFields(text);
    if (res.changed) {
      text = res.text;
      changed = true;
      notes.push(`commented ${res.fields.join(', ')}`);
    }
  }

  return { text, changed, notes };
}

// Shared: comment out a model value the target cannot resolve.
function checkModel(text, target, notes) {
  const model = getScalar(text, 'model');
  if (model === null || model.toLowerCase() === 'inherit' && target === 'cursor') return text;
  if (!isClaudeOnlyModel(model)) return text;
  const res = commentField(text, 'model', `"${model}" is a Claude Code model alias`);
  if (res.changed) notes.push('commented model');
  return res.text;
}

function commentOthers(text, allow, target, notes) {
  const res = commentFieldsExcept(text, allow, `not supported in ${target}`);
  if (res.changed) notes.push(`commented ${res.fields.join(', ')}`);
  return res.text;
}

function adaptForCursor(fileText) {
  const notes = [];
  const tools = declaredTools(fileText);
  let text = checkModel(fileText, 'cursor', notes);
  text = commentOthers(text, AGENT_FIELDS.cursor, 'cursor', notes);
  // Cursor subagents have no tools list; the closest control is `readonly`.
  if (tools && tools.length > 0 && !tools.some(t => WRITE_TOOLS.has(t)) && !hasField(text, 'readonly')) {
    text = setField(text, 'readonly', 'true');
    notes.push('added readonly');
  }
  return { text, changed: text !== fileText, notes };
}

function adaptForCopilot(fileText) {
  const notes = [];
  const tools = declaredTools(fileText);
  let text = fileText;
  if (tools && tools.length > 0) {
    const mapped = [...new Set(tools.map(t => COPILOT_TOOL[t]).filter(Boolean))];
    if (mapped.length > 0) {
      text = setField(text, 'tools', inlineList(mapped.map(t => `'${t}'`)));
      notes.push('tools mapped');
    } else {
      const res = commentField(text, 'tools', 'no Copilot equivalent for these tools');
      text = res.text;
      if (res.changed) notes.push('commented tools');
    }
  }
  text = checkModel(text, 'copilot', notes);
  text = commentOthers(text, AGENT_FIELDS.copilot, 'copilot', notes);
  return { text, changed: text !== fileText, notes };
}

function adaptForDevin(fileText) {
  const notes = [];
  const tools = declaredTools(fileText);
  let text = fileText;
  if (tools && tools.length > 0 && hasField(text, 'tools')) {
    const mapped = [...new Set(tools.map(t => DEVIN_TOOL[t] || null).filter(Boolean))];
    text = removeField(text, 'tools');
    if (mapped.length > 0) {
      text = setField(text, 'allowed-tools', inlineList(mapped));
      notes.push('tools mapped');
    } else {
      notes.push('dropped tools');
    }
  }
  text = checkModel(text, 'windsurf', notes);
  text = commentOthers(text, AGENT_FIELDS.windsurf, 'windsurf', notes);
  return { text, changed: text !== fileText, notes };
}

function adaptAsWindsurfRule(fileText) {
  const notes = [];
  const text = commentOthers(fileText, WINDSURF_RULE_FIELDS, 'windsurf', notes);
  return { text, changed: text !== fileText, notes };
}

// Codex custom agents are TOML: name, description, developer_instructions.
function adaptForCodex(fileText, options) {
  const name = getScalar(fileText, 'name') || options.name || 'agent';
  const description = getScalar(fileText, 'description') || `${name} agent`;
  const lines = [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlMultiline(stripFrontmatter(fileText))}`,
    '',
  ];
  const notes = ['converted to TOML'];
  if (declaredTools(fileText)) notes.push('dropped tools');
  return { text: lines.join('\n'), changed: true, notes };
}
