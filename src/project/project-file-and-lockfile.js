// The two committed project files.
//
//   morf.json        the "project file" — what the project asks for
//   morf.lock.json   the "lockfile"     — what the project file resolved to
//
// Neither ever holds machine-specific data: no absolute paths, no installed
// paths or hashes, no credentials. Both are written deterministically (sorted
// keys and lists, 2-space indent, trailing newline), so the same state always
// produces the same bytes.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite, readTextOrNull, stableStringify, canonical } from '../install/json-file.js';
import { TYPES } from '../repo/scan.js';
import { listTargets } from '../install/targets.js';
import { project as P } from '../util/messages.js';

export const PROJECT_FILE = 'morf.json';
export const LOCK_FILE = 'morf.lock.json';
export const PROJECT_VERSION = 1;
export const LOCK_VERSION = 1;

// The nearest directory, from `cwd` upward, that holds a project file.
export function findProjectRoot(cwd = process.cwd()) {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, PROJECT_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const itemKey = i => `${i.type}:${i.name}`;
const sortItems = items => [...items].sort((a, b) => byText(a.type, b.type) || byText(a.name, b.name));

function uniqueItems(items, extra = () => ({})) {
  const seen = new Map();
  for (const i of items) seen.set(itemKey(i), { name: i.name, type: i.type, ...extra(i) });
  return sortItems([...seen.values()]);
}

export function sourceKey(s) {
  return `${s.repo}\x00${s.ref || ''}`;
}

// ── project file ──────────────────────────────────────────────────────────────

export function emptyProject() {
  return { version: PROJECT_VERSION, sources: [] };
}

// Canonical shape: entries with the same repo, ref and targets are merged,
// entries without items are dropped, everything is sorted.
export function normalizeProject(data) {
  const merged = new Map();
  for (const s of data.sources || []) {
    const targets = [...new Set(s.targets || [])].sort();
    const key = `${sourceKey(s)}\x00${targets.join(',')}`;
    const cur = merged.get(key) || { repo: s.repo, ref: s.ref, targets, items: [] };
    cur.items.push(...(s.items || []));
    merged.set(key, cur);
  }
  const sources = [...merged.values()]
    .map(s => ({ items: uniqueItems(s.items), ref: s.ref, repo: s.repo, targets: s.targets }))
    .filter(s => s.items.length > 0 && s.targets.length > 0)
    .sort((a, b) => byText(a.repo, b.repo) || byText(a.ref || '', b.ref || '') ||
      byText(a.targets.join(','), b.targets.join(',')));
  return { version: PROJECT_VERSION, sources };
}

function validateProject(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'expected a JSON object';
  if (data.sources !== undefined && !Array.isArray(data.sources)) return '"sources" must be a list';
  for (const s of data.sources || []) {
    if (!s || typeof s.repo !== 'string' || !s.repo) return 'every source needs a "repo"';
    if (typeof s.ref !== 'string' || !s.ref) return `source ${s.repo} needs a "ref" (branch or tag)`;
    if (!Array.isArray(s.items)) return `source ${s.repo} needs an "items" list`;
    for (const i of s.items) {
      if (!i || !TYPES.includes(i.type) || typeof i.name !== 'string' || !i.name) {
        return `source ${s.repo} has an item without a valid "type" and "name"`;
      }
    }
    if (!Array.isArray(s.targets) || s.targets.length === 0) return `source ${s.repo} needs a "targets" list`;
    const bad = s.targets.find(t => !listTargets().includes(t));
    if (bad) return `source ${s.repo} names an unknown tool "${bad}"`;
  }
  return null;
}

export async function readProjectFile(root) {
  const path = join(root, PROJECT_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) return null;
  let data;
  try {
    data = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (e) {
    throw new Error(P.badProjectFile(path, e.message));
  }
  const problem = validateProject(data);
  if (problem) throw new Error(P.badProjectFile(path, problem));
  return normalizeProject(data);
}

// Writes only when the bytes would change. Returns true when it wrote.
async function writeIfChanged(path, text) {
  if (await readTextOrNull(path) === text) return false;
  await atomicWrite(path, text);
  return true;
}

export async function writeProjectFile(root, data) {
  return writeIfChanged(join(root, PROJECT_FILE), stableStringify(normalizeProject(data)));
}

// ── lockfile ──────────────────────────────────────────────────────────────────

export function emptyLock() {
  return { lockfileVersion: LOCK_VERSION, sources: [] };
}

export function normalizeLock(lock) {
  const merged = new Map();
  for (const s of lock.sources || []) {
    const cur = merged.get(sourceKey(s)) || { repo: s.repo, ref: s.ref, commit: s.commit, items: [] };
    cur.commit = s.commit;
    cur.items.push(...(s.items || []));
    merged.set(sourceKey(s), cur);
  }
  const sources = [...merged.values()]
    .map(s => ({ commit: s.commit, items: uniqueItems(s.items, i => ({ hash: i.hash })), ref: s.ref, repo: s.repo }))
    .filter(s => s.items.length > 0)
    .sort((a, b) => byText(a.repo, b.repo) || byText(a.ref || '', b.ref || ''));
  return { lockfileVersion: LOCK_VERSION, sources };
}

function validateLock(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'expected a JSON object';
  if (!Array.isArray(data.sources)) return '"sources" must be a list';
  for (const s of data.sources) {
    if (!s || typeof s.repo !== 'string' || typeof s.ref !== 'string') return 'every source needs "repo" and "ref"';
    if (typeof s.commit !== 'string' || !/^[0-9a-f]{40}$/.test(s.commit)) return `source ${s.repo} needs a full 40-character "commit"`;
    if (!Array.isArray(s.items)) return `source ${s.repo} needs an "items" list`;
    for (const i of s.items) {
      if (!i || !TYPES.includes(i.type) || typeof i.name !== 'string' || typeof i.hash !== 'string') {
        return `source ${s.repo} has an item without "type", "name" and "hash"`;
      }
    }
  }
  return null;
}

// Returns the lockfile, or null when there is none. A lockfile written by a
// newer morf is rejected without being interpreted.
export async function readLockfile(root) {
  const path = join(root, LOCK_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(P.badLockfile(path, e.message));
  }
  const version = data && data.lockfileVersion;
  if (typeof version === 'number' && version > LOCK_VERSION) {
    throw new Error(P.lockTooNew(version, LOCK_VERSION));
  }
  if (version !== LOCK_VERSION) throw new Error(P.badLockfile(path, 'missing or unsupported "lockfileVersion"'));
  const problem = validateLock(data);
  if (problem) throw new Error(P.badLockfile(path, problem));
  return normalizeLock(data);
}

// `morfVersion` is information only. To avoid churn, the file is rewritten
// only when its real content changes — never just because a different morf
// version is running. Returns true when it wrote.
export async function writeLockfile(root, lock, morfVersion) {
  const path = join(root, LOCK_FILE);
  const next = normalizeLock(lock);
  const raw = await readTextOrNull(path);
  if (raw !== null) {
    try {
      const cur = JSON.parse(raw);
      if (canonical(normalizeLock(cur)) === canonical(next) && cur.lockfileVersion === LOCK_VERSION) return false;
    } catch { /* unreadable: rewrite it */ }
  }
  return writeIfChanged(path, stableStringify({ ...next, morfVersion }));
}

// ── views used by the commands ────────────────────────────────────────────────

// What the project file asks for, as a list of
//   { repo, ref, type, name, targets: [..] }  (targets merged across entries)
export function desiredItems(projectFile) {
  const map = new Map();
  for (const s of projectFile.sources) {
    for (const i of s.items) {
      const key = `${sourceKey(s)}\x00${itemKey(i)}`;
      const cur = map.get(key) || { repo: s.repo, ref: s.ref, type: i.type, name: i.name, targets: new Set() };
      for (const t of s.targets) cur.targets.add(t);
      map.set(key, cur);
    }
  }
  return [...map.values()].map(d => ({ ...d, targets: [...d.targets].sort() }));
}

export function findLockSource(lock, repo, ref) {
  return lock.sources.find(s => s.repo === repo && s.ref === ref) || null;
}

export function findLockItem(lockSource, type, name) {
  return lockSource ? lockSource.items.find(i => i.type === type && i.name === name) || null : null;
}

// Record items for a source in the lock (replacing same-named ones).
export function lockItems(lock, { repo, ref, commit }, items) {
  let src = findLockSource(lock, repo, ref);
  if (!src) {
    src = { repo, ref, commit, items: [] };
    lock.sources.push(src);
  }
  src.commit = commit;
  for (const i of items) {
    src.items = src.items.filter(x => !(x.type === i.type && x.name === i.name));
    src.items.push({ type: i.type, name: i.name, hash: i.hash });
  }
  return lock;
}

export function unlockItem(lock, repo, ref, type, name) {
  const src = findLockSource(lock, repo, ref);
  if (src) src.items = src.items.filter(x => !(x.type === type && x.name === name));
  return lock;
}

// Add items for some targets to the project file.
export function addToProject(projectFile, { repo, ref }, items, targets) {
  projectFile.sources.push({
    repo, ref, targets: [...targets],
    items: items.map(i => ({ type: i.type, name: i.name })),
  });
  return normalizeProject(projectFile);
}

// Remove (type, name) for the given targets; the item stays for other targets.
export function removeFromProject(projectFile, type, name, targets) {
  const out = [];
  for (const s of projectFile.sources) {
    const has = s.items.some(i => i.type === type && i.name === name);
    const hit = s.targets.filter(t => targets.includes(t));
    if (!has || hit.length === 0) { out.push(s); continue; }
    const rest = s.items.filter(i => !(i.type === type && i.name === name));
    const keep = s.targets.filter(t => !targets.includes(t));
    // Everything else in this entry keeps all its targets...
    if (rest.length) out.push({ ...s, items: rest });
    // ...and the item itself keeps the targets that were not removed.
    if (keep.length) out.push({ ...s, items: [{ type, name }], targets: keep });
  }
  return normalizeProject({ sources: out });
}
