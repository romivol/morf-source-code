// Hook conversion.
//
// The source format is the Claude Code one (the same convention morf uses for
// agents); the converter reshapes it for one target tool.
//
//   convertHook -> { value, notes } | { text, notes } | { unsupported }
//
// `value` is merged into a shared JSON config; `text` is written as a file.

import { OC_LIKE } from './shared.js';

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
