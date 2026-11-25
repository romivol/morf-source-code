import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from '../install/json-file.js';

// Every primitive morf understands, in display/install order.
export const TYPES = ['skill', 'agent', 'rule', 'prompt', 'hook', 'mcp'];

// Scan a cloned repo and return [{type, name, srcPath, payload?, invalid?}] for
// every primitive found. Missing top-level dirs are silently skipped (spec E6).
//
//   skills/<name>/SKILL.md        skill   (directory)
//   agents/<name>.md              agent   (file)
//   rules/<name>.md|.mdc          rule    (file)
//   prompts/<name>.md             prompt  (file; commands/<name>.md also accepted)
//   hooks/<name>.json             hook    (payload: { Event: [matcher groups] })
//   mcp/<name>.json               mcp     (payload: one server definition)
//   .mcp.json | mcp.json          mcp     (one item per entry under mcpServers)
//
// hook and mcp items carry a parsed `payload`; a file that cannot be parsed is
// still returned, with `invalid` set to the reason, so install can report it.
export async function scanRepo(repoDir) {
  const groups = await Promise.all([
    collect(scanSkills, repoDir),
    collect(scanAgents, repoDir),
    collect(scanRules, repoDir),
    collect(scanPrompts, repoDir),
    collect(scanHooks, repoDir),
    collect(scanMcp, repoDir),
  ]);
  return groups.flat();
}

async function collect(fn, repoDir) {
  const items = [];
  await fn(repoDir, items);
  return items;
}

async function readDirOrEmpty(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

function stripExt(name, exts) {
  for (const ext of exts) {
    if (name.toLowerCase().endsWith(ext)) return name.slice(0, -ext.length);
  }
  return null;
}

// A directory is a skill iff it contains SKILL.md (spec E6).
async function isSkillDir(dirPath) {
  try { await fs.access(join(dirPath, 'SKILL.md')); return true; }
  catch { return false; }
}

async function scanSkills(repoDir, items) {
  const skillsDir = join(repoDir, 'skills');
  for (const entry of await readDirOrEmpty(skillsDir)) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    if (!await isSkillDir(skillDir)) continue;
    items.push({ type: 'skill', name: entry.name, srcPath: skillDir });
  }
}

async function scanAgents(repoDir, items) {
  const agentsDir = join(repoDir, 'agents');
  for (const entry of await readDirOrEmpty(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    items.push({ type: 'agent', name: entry.name.slice(0, -3), srcPath: join(agentsDir, entry.name) });
  }
}

async function scanRules(repoDir, items) {
  const dir = join(repoDir, 'rules');
  const seen = new Set();
  for (const entry of await readDirOrEmpty(dir)) {
    if (!entry.isFile()) continue;
    const name = stripExt(entry.name, ['.mdc', '.md']);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({ type: 'rule', name, srcPath: join(dir, entry.name) });
  }
}

async function scanPrompts(repoDir, items) {
  const seen = new Set();
  for (const sub of ['prompts', 'commands']) {
    const dir = join(repoDir, sub);
    for (const entry of await readDirOrEmpty(dir)) {
      if (!entry.isFile()) continue;
      const name = stripExt(entry.name, ['.prompt.md', '.md']);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      items.push({ type: 'prompt', name, srcPath: join(dir, entry.name) });
    }
  }
}

async function readJsonPayload(path) {
  const { data } = parseJsonc(await fs.readFile(path, 'utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('expected a JSON object');
  }
  return data;
}

// hooks/<name>.json — Claude-style: { "hooks": { "<Event>": [ { matcher, hooks: [...] } ] } }
// (the outer "hooks" wrapper is optional).
async function scanHooks(repoDir, items) {
  const dir = join(repoDir, 'hooks');
  for (const entry of await readDirOrEmpty(dir)) {
    if (!entry.isFile()) continue;
    const name = stripExt(entry.name, ['.jsonc', '.json']);
    if (!name) continue;
    const srcPath = join(dir, entry.name);
    try {
      const data = await readJsonPayload(srcPath);
      const payload = data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)
        ? data.hooks : data;
      items.push({ type: 'hook', name, srcPath, payload });
    } catch (e) {
      items.push({ type: 'hook', name, srcPath, invalid: `invalid hook file: ${e.message}` });
    }
  }
}

function isServerDef(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) &&
    (typeof v.command === 'string' || Array.isArray(v.command) || typeof v.url === 'string');
}

function serverMap(data) {
  const map = data.mcpServers || data.servers;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
}

// mcp/<name>.json holds one server (or an { mcpServers: {...} } map);
// a root .mcp.json / mcp.json holds a map. One item per server.
async function scanMcp(repoDir, items) {
  const seen = new Set();
  const add = (name, srcPath, payload) => {
    if (seen.has(name)) return;
    seen.add(name);
    if (isServerDef(payload)) items.push({ type: 'mcp', name, srcPath, payload });
    else items.push({ type: 'mcp', name, srcPath, invalid: 'invalid MCP server: needs "command" or "url"' });
  };
  const addMap = (map, srcPath) => {
    for (const [name, def] of Object.entries(map)) add(name, srcPath, def);
  };

  const dir = join(repoDir, 'mcp');
  for (const entry of await readDirOrEmpty(dir)) {
    if (!entry.isFile()) continue;
    const name = stripExt(entry.name, ['.jsonc', '.json']);
    if (!name) continue;
    const srcPath = join(dir, entry.name);
    try {
      const data = await readJsonPayload(srcPath);
      const map = isServerDef(data) ? null : serverMap(data);
      if (map) addMap(map, srcPath);
      else add(name, srcPath, data);
    } catch (e) {
      if (!seen.has(name)) {
        seen.add(name);
        items.push({ type: 'mcp', name, srcPath, invalid: `invalid MCP file: ${e.message}` });
      }
    }
  }

  for (const file of ['.mcp.json', 'mcp.json']) {
    const srcPath = join(repoDir, file);
    try {
      const map = serverMap(await readJsonPayload(srcPath));
      if (map) addMap(map, srcPath);
    } catch { /* absent or unreadable root file: nothing to install */ }
  }
}
