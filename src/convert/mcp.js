// MCP server conversion.
//
// The source format is the Claude Code one (the same convention morf uses for
// agents); the converter reshapes it for one target tool.
//
//   convertMcp -> { value, notes } | { text, notes }
//
// `value` is merged into a shared JSON config; `text` is written as a
// marker-delimited block.

import { OC_LIKE } from './shared.js';

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

  // A project .mcp.json is one entry read by both Claude Code and Copilot.
  // It never carries "tools": Claude Code drops a remote entry that has the
  // key, without a message (seen in 2.1.332), and Copilot defaults to all tools
  // when it is absent (seen in CLI 1.0.116). Only Copilot's own global file
  // gets the key.
  if (target === 'shared') {
    return {
      value: s.remote
        ? clean({ type: s.transport, url: s.url, headers: s.headers })
        : clean({ type: 'stdio', command: s.command, args: s.args, env: s.env }),
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
