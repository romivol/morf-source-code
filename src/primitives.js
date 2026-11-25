// Converters for rules, prompts, hooks and MCP servers.
//
// The source format for each is the Claude Code one (the same convention morf
// uses for agents); every converter reshapes it for one target tool.
//
//   convertRule / convertPrompt  -> { text, notes }
//   convertHook                  -> { value, notes } | { text, notes } | { unsupported }
//   convertMcp                   -> { value, notes } | { text, notes }
//
// `value` is merged into a shared JSON config; `text` is written as a file or
// as a marker-delimited block.

import {
  parseFrontmatter, stripFrontmatter, getScalar, getList,
  setField, removeField, commentField, commentFieldsExcept, yamlString,
} from './frontmatter.js';

const OC_LIKE = new Set(['opencode', 'kilo']);

function commentOthers(text, allow, target, notes) {
  const res = commentFieldsExcept(text, allow, `not supported in ${target}`);
  if (res.changed) notes.push(`commented ${res.fields.join(', ')}`);
  return res.text;
}

// Drop a frontmatter block that ended up with no fields.
function dropEmptyFrontmatter(text) {
  const parsed = parseFrontmatter(text);
  if (parsed && parsed.fmLines.every(l => l.trim() === '')) return stripFrontmatter(text);
  return text;
}

// ── Rules ─────────────────────────────────────────────────────────────────────
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

// ── Prompts (custom slash commands) ───────────────────────────────────────────
// Source: Claude Code command — frontmatter description, argument-hint,
// allowed-tools, model; body uses $ARGUMENTS / $1.

const PROMPT_FIELDS = {
  opencode: new Set(['description', 'agent', 'model', 'subtask', 'variant']),
  kilo:     new Set(['description', 'agent', 'model', 'subtask', 'variant']),
  copilot:  new Set(['name', 'description', 'argument-hint', 'agent', 'model', 'tools']),
  windsurf: new Set(['title', 'description']),
  codex:    new Set(['description', 'argument-hint']),
};

function isClaudeOnlyModel(value) {
  return /^(sonnet|opus|haiku|fable|inherit)(\[.*\])?$/i.test(value) || /^claude-/i.test(value);
}

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

// ── Hooks ─────────────────────────────────────────────────────────────────────
// Source: Claude Code hooks — { Event: [ { matcher?, hooks: [ { type: "command",
// command, timeout? } ] } ] }.

const same = names => Object.fromEntries(names.map(n => [n, n]));

const HOOK_EVENTS = {
  codex: same(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse',
    'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop']),
  windsurf: {
    ...same(['PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd']),
    PostCompact: 'PostCompaction',
  },
  cursor: {
    PreToolUse: 'preToolUse', PostToolUse: 'postToolUse', PostToolUseFailure: 'postToolUseFailure',
    SessionStart: 'sessionStart', SessionEnd: 'sessionEnd', UserPromptSubmit: 'beforeSubmitPrompt',
    Stop: 'stop', SubagentStart: 'subagentStart', SubagentStop: 'subagentStop', PreCompact: 'preCompact',
  },
  copilot: {
    PreToolUse: 'preToolUse', PostToolUse: 'postToolUse', PostToolUseFailure: 'postToolUseFailure',
    SessionStart: 'sessionStart', SessionEnd: 'sessionEnd', UserPromptSubmit: 'userPromptSubmitted',
    Stop: 'agentStop', SubagentStart: 'subagentStart', SubagentStop: 'subagentStop',
    PreCompact: 'preCompact', Notification: 'notification', PermissionRequest: 'permissionRequest',
  },
  // Events the generated OpenCode/Kilo plugin can observe.
  opencode: same(['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']),
};
HOOK_EVENTS.kilo = HOOK_EVENTS.opencode;

// Claude tool names inside a matcher regex -> the target's tool names.
const MATCHER_TOOLS = {
  windsurf: { Bash: 'exec', Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', Grep: 'grep', Glob: 'glob' },
  cursor:   { Bash: 'Shell', Edit: 'Write', MultiEdit: 'Write' },
};

function mapMatcher(matcher, target) {
  const table = MATCHER_TOOLS[target];
  if (!table || typeof matcher !== 'string') return matcher;
  const mapped = matcher.replace(/\b[A-Za-z]+\b/g, w => (Object.prototype.hasOwnProperty.call(table, w) ? table[w] : w));
  // "Edit|Write" can collapse to "Write|Write": de-duplicate plain alternations.
  if (/^[\w|]+$/.test(mapped)) return [...new Set(mapped.split('|'))].join('|');
  return mapped;
}

// Flatten the source into [{ event, matcher, handler }] keeping command handlers only.
function flattenHooks(payload, notes) {
  const out = [];
  let droppedHandlers = 0;
  for (const [event, groups] of Object.entries(payload || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const handlers = Array.isArray(group.hooks) ? group.hooks : (group.command ? [group] : []);
      for (const h of handlers) {
        if (!h || typeof h.command !== 'string' || (h.type && h.type !== 'command')) { droppedHandlers++; continue; }
        out.push({ event, matcher: typeof group.matcher === 'string' ? group.matcher : null, handler: h });
      }
    }
  }
  if (droppedHandlers) notes.push(`dropped ${droppedHandlers} non-command handler${droppedHandlers === 1 ? '' : 's'}`);
  return out;
}

export function convertHook(payload, target, { name = 'hook' } = {}) {
  const notes = [];

  // Claude Code is the source format: merge it untouched.
  if (target === 'claude') {
    const value = {};
    for (const [event, groups] of Object.entries(payload || {})) {
      if (Array.isArray(groups) && groups.length > 0) value[event] = groups;
    }
    if (Object.keys(value).length === 0) return { unsupported: 'no hooks defined' };
    return { value, notes };
  }

  const events = HOOK_EVENTS[target];
  if (!events) return { unsupported: `not supported by ${target}` };

  const flat = flattenHooks(payload, notes);
  const kept = flat.filter(f => Object.prototype.hasOwnProperty.call(events, f.event));
  const dropped = [...new Set(flat.filter(f => !kept.includes(f)).map(f => f.event))];
  if (dropped.length) notes.push(`dropped ${dropped.join(', ')}`);
  if (kept.length === 0) {
    return { unsupported: flat.length ? `no ${target} equivalent for ${dropped.join(', ')}` : 'no command hooks defined' };
  }
  if (kept.some(f => events[f.event] !== f.event) || MATCHER_TOOLS[target]) notes.unshift('events mapped');

  if (OC_LIKE.has(target)) {
    return { text: renderPlugin(name, kept), notes: ['generated plugin', ...notes.filter(n => n !== 'events mapped')] };
  }

  const value = {};
  const push = (event, entry) => { (value[event] = value[event] || []).push(entry); };

  for (const { event, matcher, handler } of kept) {
    const ev = events[event];
    const m = matcher && matcher !== '*' ? mapMatcher(matcher, target) : null;
    if (target === 'cursor') {
      const entry = { command: handler.command };
      if (m) entry.matcher = m;
      if (typeof handler.timeout === 'number') entry.timeout = handler.timeout;
      push(ev, entry);
    } else if (target === 'copilot') {
      const entry = { type: 'command', command: handler.command };
      if (m) entry.matcher = m;
      if (typeof handler.timeout === 'number') entry.timeoutSec = handler.timeout;
      push(ev, entry);
    } else {
      // codex / windsurf (Devin): Claude-compatible matcher groups.
      const h = { type: 'command', command: handler.command };
      if (typeof handler.timeout === 'number') h.timeout = handler.timeout;
      const group = m ? { matcher: m, hooks: [h] } : { hooks: [h] };
      push(ev, group);
    }
  }

  if (target === 'copilot') {
    // Copilot reads one JSON file per hook set from .github/hooks/.
    return { text: JSON.stringify({ version: 1, hooks: value }, null, 2) + '\n', notes };
  }
  return { value, notes };
}

// OpenCode and Kilo have no declarative hooks: emit a plugin that runs the same
// shell commands on the matching plugin events, feeding them a Claude-style
// JSON payload on stdin. Exit code 2 from a PreToolUse command blocks the tool.
function renderPlugin(name, kept) {
  const table = {};
  for (const { event, matcher, handler } of kept) {
    const entry = { command: handler.command };
    if (matcher && matcher !== '*') entry.matcher = matcher;
    if (typeof handler.timeout === 'number') entry.timeout = handler.timeout;
    (table[event] = table[event] || []).push(entry);
  }
  const has = e => Boolean(table[e]);
  const ident = 'MorfHook_' + name.replace(/[^A-Za-z0-9_]/g, '_');

  const lines = [
    `// Generated by morf from the hook set "${name}". Edits here count as local changes.`,
    `import { spawnSync } from "node:child_process";`,
    ``,
    `const HOOKS = ${JSON.stringify(table, null, 2)};`,
    ``,
    `// Plugin tool ids -> the Claude Code tool names the matchers were written for.`,
    `const TOOL_NAMES = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", glob: "Glob",`,
    `  grep: "Grep", list: "LS", task: "Task", webfetch: "WebFetch", todowrite: "TodoWrite" };`,
    ``,
    `function matches(matcher, tool) {`,
    `  if (!matcher) return true;`,
    `  const names = [tool, TOOL_NAMES[tool] || tool];`,
    `  try {`,
    `    const re = new RegExp("^(?:" + matcher + ")$");`,
    `    return names.some((n) => re.test(n));`,
    `  } catch {`,
    `    return names.includes(matcher);`,
    `  }`,
    `}`,
    ``,
    `// Runs every command registered for the event. Returns a reason string when a`,
    `// command exits with code 2 (the "block" signal), otherwise null.`,
    `function run(event, cwd, payload, tool) {`,
    `  for (const hook of HOOKS[event] || []) {`,
    `    if (tool !== undefined && !matches(hook.matcher, tool)) continue;`,
    `    const res = spawnSync(hook.command, {`,
    `      shell: true,`,
    `      cwd,`,
    `      encoding: "utf8",`,
    `      timeout: (hook.timeout || 60) * 1000,`,
    `      input: JSON.stringify({ hook_event_name: event, cwd, ...payload }),`,
    `    });`,
    `    if (res.status === 2) return (res.stderr || "").trim() || "blocked by hook: " + hook.command;`,
    `  }`,
    `  return null;`,
    `}`,
    ``,
    `export const ${ident} = async ({ directory }) => ({`,
  ];

  if (has('PreToolUse')) {
    lines.push(
      `  "tool.execute.before": async (input, output) => {`,
      `    const blocked = run("PreToolUse", directory, {`,
      `      session_id: input.sessionID,`,
      `      tool_name: TOOL_NAMES[input.tool] || input.tool,`,
      `      tool_input: output.args,`,
      `    }, input.tool);`,
      `    if (blocked) throw new Error(blocked);`,
      `  },`,
    );
  }
  if (has('PostToolUse')) {
    lines.push(
      `  "tool.execute.after": async (input, output) => {`,
      `    run("PostToolUse", directory, {`,
      `      session_id: input.sessionID,`,
      `      tool_name: TOOL_NAMES[input.tool] || input.tool,`,
      `      tool_input: input.args,`,
      `      tool_response: output.output,`,
      `    }, input.tool);`,
      `  },`,
    );
  }
  if (has('UserPromptSubmit')) {
    lines.push(
      `  "chat.message": async (input, output) => {`,
      `    const prompt = (output.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\\n");`,
      `    run("UserPromptSubmit", directory, { session_id: input.sessionID, prompt });`,
      `  },`,
    );
  }
  if (has('SessionStart') || has('Stop')) {
    lines.push(`  event: async ({ event }) => {`);
    if (has('SessionStart')) lines.push(`    if (event.type === "session.created") run("SessionStart", directory, {});`);
    if (has('Stop')) lines.push(`    if (event.type === "session.idle") run("Stop", directory, {});`);
    lines.push(`  },`);
  }
  lines.push(`});`, ``);
  return lines.join('\n');
}

// ── MCP servers ───────────────────────────────────────────────────────────────
// Source: a Claude Code .mcp.json entry — { command, args, env } for stdio or
// { type: "http" | "sse", url, headers } for remote servers.

const ENV_REF = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

// Rewrite ${VAR} references into the target's interpolation syntax.
function mapEnvRefs(value, fmt) {
  if (typeof value === 'string') return value.replace(ENV_REF, (_m, n) => fmt(n));
  if (Array.isArray(value)) return value.map(v => mapEnvRefs(v, fmt));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapEnvRefs(v, fmt)]));
  }
  return value;
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Normalize any accepted source shape.
export function normalizeMcp(def) {
  if (typeof def.url === 'string' && def.command === undefined) {
    const t = String(def.type || def.transport || 'http').toLowerCase();
    return { remote: true, transport: t === 'sse' ? 'sse' : 'http', url: def.url, headers: plainObject(def.headers) };
  }
  const cmd = Array.isArray(def.command) ? def.command.map(String) : [String(def.command)];
  return {
    remote: false,
    command: cmd[0],
    args: [...cmd.slice(1), ...(Array.isArray(def.args) ? def.args.map(String) : [])],
    env: plainObject(def.env || def.environment),
  };
}

const nonEmpty = o => Object.keys(o).length > 0;

function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function tomlInlineTable(obj) {
  return '{ ' + Object.entries(obj).map(([k, v]) => `${tomlKey(k)} = ${JSON.stringify(String(v))}`).join(', ') + ' }';
}

export function convertMcp(def, target, { name = 'server' } = {}) {
  const s = normalizeMcp(def);
  const notes = [];

  if (target === 'claude') {
    return {
      value: s.remote
        ? clean({ type: s.transport, url: s.url, headers: s.headers })
        : clean({ command: s.command, args: s.args, env: s.env }),
      notes,
    };
  }

  if (target === 'copilot') {
    return {
      value: s.remote
        ? clean({ type: s.transport, url: s.url, headers: s.headers, tools: ['*'] })
        : clean({ type: 'stdio', command: s.command, args: s.args, env: s.env, tools: ['*'] }),
      notes,
    };
  }

  if (target === 'cursor') {
    const v = s.remote
      ? clean({ url: s.url, headers: s.headers })
      : clean({ type: 'stdio', command: s.command, args: s.args, env: s.env });
    return { value: mapEnvRefs(v, n => `\${env:${n}}`), notes };
  }

  if (target === 'windsurf') {
    const v = s.remote
      ? clean({ url: s.url, transport: s.transport, headers: s.headers })
      : clean({ command: s.command, args: s.args, env: s.env });
    return { value: mapEnvRefs(v, n => `\${env:${n}}`), notes };
  }

  if (OC_LIKE.has(target)) {
    const v = s.remote
      ? clean({ type: 'remote', url: s.url, headers: s.headers, enabled: true })
      : clean({ type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true });
    return { value: mapEnvRefs(v, n => `{env:${n}}`), notes };
  }

  if (target === 'codex') {
    const table = `mcp_servers.${tomlKey(name)}`;
    const lines = [`[${table}]`];
    if (s.remote) {
      lines.push(`url = ${JSON.stringify(s.url)}`);
      const headers = { ...s.headers };
      // "Authorization: Bearer ${TOKEN}" -> bearer_token_env_var
      const authKey = Object.keys(headers).find(k => k.toLowerCase() === 'authorization');
      const bearer = authKey && String(headers[authKey]).match(/^Bearer \$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (bearer) {
        lines.push(`bearer_token_env_var = ${JSON.stringify(bearer[1])}`);
        delete headers[authKey];
      }
      if (nonEmpty(headers)) lines.push(`http_headers = ${tomlInlineTable(headers)}`);
      if (s.transport === 'sse') notes.push('sse served as http');
    } else {
      lines.push(`command = ${JSON.stringify(s.command)}`);
      if (s.args.length) lines.push(`args = [${s.args.map(a => JSON.stringify(a)).join(', ')}]`);
      // KEY: "${KEY}" just forwards a variable: Codex spells that env_vars.
      const forwarded = [];
      const literal = {};
      for (const [k, v] of Object.entries(s.env)) {
        const m = String(v).match(/^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/);
        if (m && m[1] === k) forwarded.push(k);
        else literal[k] = v;
      }
      if (forwarded.length) lines.push(`env_vars = [${forwarded.map(k => JSON.stringify(k)).join(', ')}]`);
      if (nonEmpty(literal)) {
        lines.push('', `[${table}.env]`);
        for (const [k, v] of Object.entries(literal)) lines.push(`${tomlKey(k)} = ${JSON.stringify(String(v))}`);
      }
    }
    return { text: lines.join('\n') + '\n', notes };
  }

  throw new Error(`MCP servers are not supported by ${target}`);
}

// Drop empty args / env / headers so the written entry stays minimal.
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length === 0 && k !== 'tools') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !nonEmpty(v)) continue;
    out[k] = v;
  }
  return out;
}
