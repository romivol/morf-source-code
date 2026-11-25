import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { printable } from '../util/log.js';
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
//
// Symbolic links and submodules are never followed, copied or fetched. An item
// that is one, or contains one, is returned with `invalid` set, so that
// nothing from it is installed. `special` is what git says the checkout holds
// ({ symlinks, submodules }, see git.js specialEntries); the directory is also
// checked directly, which covers a link that exists on disk.
export async function scanRepo(repoDir, special = null) {
  const groups = await Promise.all([
    collect(scanSkills, repoDir),
    collect(scanAgents, repoDir),
    collect(scanRules, repoDir),
    collect(scanPrompts, repoDir),
    collect(scanHooks, repoDir),
    collect(scanMcp, repoDir),
  ]);
  const items = groups.flat();
  for (const item of items) {
    if (item.invalid) continue;
    const rel = relative(repoDir, item.srcPath).split('\\').join('/');
    const within = p => p === rel || p.startsWith(rel + '/');
    const link = special && special.symlinks.find(within);
    const sub = special && special.submodules.find(within);
    if (link) item.invalid = refusedLink(link);
    else if (sub) item.invalid = `contains a git submodule (${printable(sub)}); morf does not fetch submodules`;
    else {
      const onDisk = await findLinkOnDisk(item.srcPath);
      if (onDisk !== null) item.invalid = refusedLink(rel + (onDisk ? '/' + onDisk : ''));
    }
  }
  return items;
}

function refusedLink(path) {
  return `contains a symbolic link (${printable(path)}); morf does not follow or copy links`;
}

// The path (relative to `p`, '' for `p` itself) of the first symbolic link at
// or under `p`, or null when there is none.
async function findLinkOnDisk(p) {
  let st;
  try { st = await fs.lstat(p); } catch { return null; }
  if (st.isSymbolicLink()) return '';
  if (!st.isDirectory()) return null;
  for (const entry of await fs.readdir(p, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return entry.name;
    if (entry.isDirectory()) {
      const inner = await findLinkOnDisk(join(p, entry.name));
      if (inner !== null) return inner === '' ? entry.name : `${entry.name}/${inner}`;
    }
  }
  return null;
}

async function collect(fn, repoDir) {
  const items = [];
  await fn(repoDir, items);
  return items;
}

// A link is listed like a file so that it can be refused by name.
const isFileOrLink = entry => entry.isFile() || entry.isSymbolicLink();

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
    if (entry.isSymbolicLink()) { items.push({ type: 'skill', name: entry.name, srcPath: join(skillsDir, entry.name) }); continue; }
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    if (!await isSkillDir(skillDir)) continue;
    items.push({ type: 'skill', name: entry.name, srcPath: skillDir });
  }
}

async function scanAgents(repoDir, items) {
  const agentsDir = join(repoDir, 'agents');
  for (const entry of await readDirOrEmpty(agentsDir)) {
    if (!isFileOrLink(entry) || !entry.name.endsWith('.md')) continue;
    items.push({ type: 'agent', name: entry.name.slice(0, -3), srcPath: join(agentsDir, entry.name) });
  }
}

async function scanRules(repoDir, items) {
  const dir = join(repoDir, 'rules');
  const seen = new Set();
  for (const entry of await readDirOrEmpty(dir)) {
    if (!isFileOrLink(entry)) continue;
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
      if (!isFileOrLink(entry)) continue;
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
    if (!isFileOrLink(entry)) continue;
    const name = stripExt(entry.name, ['.jsonc', '.json']);
    if (!name) continue;
    const srcPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) { items.push({ type: 'hook', name, srcPath, payload: {} }); continue; }
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
    if (!isFileOrLink(entry)) continue;
    const name = stripExt(entry.name, ['.jsonc', '.json']);
    if (!name) continue;
    const srcPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) { items.push({ type: 'mcp', name, srcPath, payload: {} }); continue; }
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
      // A linked file is never read through the link: report it instead.
      if ((await fs.lstat(srcPath)).isSymbolicLink()) {
        items.push({ type: 'mcp', name: file, srcPath, payload: {} });
        continue;
      }
      const map = serverMap(await readJsonPayload(srcPath));
      if (map) addMap(map, srcPath);
    } catch { /* absent or unreadable root file: nothing to install */ }
  }
}
