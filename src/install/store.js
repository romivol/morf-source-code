// Storage layer: where an installed item lives for a (target, type) pair and how
// to read, write and remove it. Hides the four mapping kinds from the commands:
//
//   dir    a copied folder                       (skills)
//   file   one written file, optionally listed in a JSON array ("register")
//   json   a value merged into a shared JSON config
//   block  a marker-delimited block inside a shared text file
//
// The same questions are answered for every kind:
//   currentHash(loc, record)      what is on disk now (null = nothing)
//   matchesRendered(loc, rendered) is what is on disk exactly what morf would write
//   write(loc, rendered, record)  put it there, return the installed hash
//   remove(loc, record)           take it out again, leaving everything else alone
//
// Shared files (settings.json, mcp.json, opencode.json, kilo.jsonc, AGENTS.md,
// config.toml, ...) belong to the user. morf changes only its own entries: all
// other bytes stay as written, including comments and key order. A file that
// cannot be parsed is never overwritten.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { tableFor, resolveDestination } from './targets.js';
import { assertPathInside, sanitizeName } from '../util/sanitize.js';
import { printable } from '../util/log.js';
import { ensureDir, copyDir, removePath, hashPath } from '../util/fs.js';
import {
  readJsonFile, readTextOrNull, atomicWrite, hashValue, hashText, deepEqual,
} from './json-file.js';
import { parseText, getPath, setPath, removePath as removeJsonPath, arrayAppend, arrayRemove } from './json-edit.js';

function underHome(p) {
  const rel = relative(homedir(), p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Keep one copy of a user file as it was before morf first changed it.
async function backupOnce(file) {
  const backup = file + '.morf-backup';
  try {
    await fs.access(backup);
  } catch {
    await fs.copyFile(file, backup).catch(() => {});
  }
}

// Resolve the on-disk location of an item. `name` must already be sanitized.
// `scope` is null for a global install or { project: root } for project mode.
export function locate(target, type, name, scope = null) {
  // The name becomes part of a path, so it is checked here, at the one place
  // every path is built — whether it came from a repository, the project file
  // or the install record. It must be exactly what the sanitizer produces.
  let safe = null;
  try { safe = sanitizeName(name); } catch { /* not sanitizable at all */ }
  if (typeof name !== 'string' || safe !== name) {
    throw new Error(
      `The item name "${printable(String(name))}" is not in the form morf uses for file names` +
      `${safe ? ` (expected "${safe}")` : ''}. If it comes from the install record, that entry is damaged.`);
  }
  const mapping = resolveDestination(target, type, scope);
  const { kind } = mapping;
  // Outside a project, a shared user file under the home directory is backed
  // up (once, as <file>.morf-backup) before morf changes it for the first time.
  // Project files are under version control, so they need no backup.
  const sharedFile = mapping.file || (mapping.register && mapping.register.file) || null;
  const backup = !scope && Boolean(sharedFile) && underHome(sharedFile);
  const base = { target, type, name, mapping, kind, shared: Boolean(mapping.shared), backup };
  if (kind === 'dir') {
    const destPath = join(mapping.base, name);
    assertPathInside(mapping.base, destPath);
    return { ...base, destPath, display: destPath, physical: destPath };
  }
  if (kind === 'file') {
    const destPath = join(mapping.base, (mapping.prefix || '') + name + mapping.ext);
    assertPathInside(mapping.base, destPath);
    return { ...base, destPath, display: destPath, physical: destPath };
  }
  const where = kind === 'json' && mapping.mode === 'entry'
    ? [...mapping.path, name].join('.')
    : (mapping.path && mapping.path.length ? mapping.path.join('.') : `${type}:${name}`);
  return {
    ...base,
    destPath: mapping.file,
    display: `${mapping.file} (${where})`,
    // Identity of the physical thing written: two targets that resolve to the
    // same `physical` share one item on disk.
    physical: `${mapping.file}#${type}:${name}`,
  };
}

// Hash of an item as it exists in the source repo (install-record flavour).
export async function sourceHashOf(item) {
  if (item.payload !== undefined) return hashValue(item.payload);
  return hashPath(item.srcPath, { strict: true });
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function getAt(data, path) {
  let cur = data;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

const hasEntry = (list, entry) => Array.isArray(list) && list.some(e => deepEqual(e, entry));

// How many of the entries in `payload` ({ Event: [entries] }) are present.
function countHookEntries(container, payload) {
  let total = 0;
  let found = 0;
  for (const [event, entries] of Object.entries(payload || {})) {
    for (const entry of entries) {
      total++;
      if (container && hasEntry(container[event], entry)) found++;
    }
  }
  return { total, found };
}

function isStrictJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

// Apply a text edit to a shared JSON(C) file. The edit sees the current text
// ('' when the file does not exist) and returns the new text. Nothing is
// written when the file cannot be parsed, when the edit changes nothing, or
// when the result would no longer parse.
async function editJsonFile(file, edit, backup = false) {
  const raw = await readTextOrNull(file);
  const hasContent = raw !== null && raw.trim() !== '';
  if (hasContent) {
    try {
      parseText(raw);
    } catch (e) {
      throw new Error(`${file} is not valid JSON, so morf left it untouched (${e.message})`);
    }
  }
  const next = edit(raw ?? '');
  if (next === null || next === raw) return;
  try {
    parseText(next);
    if ((!hasContent || isStrictJson(raw)) && !isStrictJson(next)) throw new Error('result is not strict JSON');
  } catch (e) {
    throw new Error(`morf could not edit ${file} safely and left it untouched (${e.message})`);
  }
  if (backup && raw !== null) await backupOnce(file);
  await atomicWrite(file, next);
}

function removeHookEntries(text, path, payload) {
  let t = text;
  for (const [event, entries] of Object.entries(payload || {})) {
    const before = t;
    for (const entry of entries) t = arrayRemove(t, [...path, event], entry);
    // Drop the event's array only if morf emptied it.
    const left = getPath(t, [...path, event]);
    if (t !== before && Array.isArray(left) && left.length === 0) t = removeJsonPath(t, [...path, event]);
  }
  return t;
}

// ── Text block helpers ────────────────────────────────────────────────────────

function markers(loc) {
  const id = `${loc.type}:${loc.name}`;
  return loc.mapping.style === 'toml'
    ? { begin: `# >>> morf ${id}`, end: `# <<< morf ${id}` }
    : { begin: `<!-- morf:${id} -->`, end: `<!-- /morf:${id} -->` };
}

const stripCr = l => l.replace(/\r$/, '');

// Returns { lines, b, e } (marker line indexes) or null when the block is absent.
function findBlock(text, { begin, end }) {
  if (text == null) return null;
  const lines = text.split('\n');
  const b = lines.findIndex(l => stripCr(l) === begin);
  if (b === -1) return null;
  const e = lines.findIndex((l, i) => i > b && stripCr(l) === end);
  if (e === -1) return null;
  return { lines, b, e };
}

function blockInner(found) {
  return found.lines.slice(found.b + 1, found.e).map(stripCr).join('\n');
}

function normalizeInner(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

// Text written into a block must not contain anything that looks like one of
// morf's own marker lines: the block would end early, and the rest of the text
// would be left behind in the user's file when the item is removed.
const MARKER_IN_TEXT = /<!--\s*\/?morf:[^>]*-->|^[ \t]*#[ \t]*(?:>>>|<<<)[ \t]*morf\b/m;

export function assertNoMarker(loc, text) {
  if (loc.kind !== 'block') return;
  const found = String(text).match(MARKER_IN_TEXT);
  if (found) {
    throw new Error(
      `its text contains one of morf's own block markers ("${printable(found[0].trim())}"), ` +
      `which would break the block in ${loc.mapping.file}`);
  }
}

// A TOML table morf is about to write must not already exist outside its block.
function assertNoForeignTable(outsideLines, inner, file) {
  const header = inner.split('\n').find(l => l.startsWith('['));
  if (!header) return;
  if (outsideLines.some(l => stripCr(l).trim() === header)) {
    throw new Error(`${header} is already defined in ${file} outside morf; remove it there first`);
  }
}

// ── currentHash ───────────────────────────────────────────────────────────────

// Hash of what is on disk for this item, or null when nothing is there.
// `record` is the install record, if any (needed to recognise merged hooks).
export async function currentHash(loc, record = null) {
  const { kind, mapping } = loc;

  if (kind === 'dir' || kind === 'file') {
    try {
      await fs.access(loc.destPath);
    } catch {
      return null;
    }
    return hashPath(loc.destPath);
  }

  if (kind === 'json') {
    const { data } = await readJsonFile(mapping.file);
    const container = getAt(data, mapping.path);
    if (mapping.mode === 'entry') {
      const cur = container ? container[loc.name] : undefined;
      return cur === undefined ? null : hashValue(cur);
    }
    // hooks: entries are anonymous, so they are recognised by the payload
    // recorded at install time.
    if (!record || !record.payload) return null;
    const { total, found } = countHookEntries(container, record.payload);
    if (found === 0) return null;
    return found === total ? hashValue(record.payload) : 'partial';
  }

  // block
  const found = findBlock(await readTextOrNull(mapping.file), markers(loc));
  return found ? hashText(blockInner(found)) : null;
}

// True when what is on disk is exactly what morf would write for `rendered`.
// Lets morf recognise items that are already in place without an install
// record — for example tool files a teammate committed to the repository.
export async function matchesRendered(loc, rendered) {
  const { kind, mapping } = loc;
  try {
    if (kind === 'dir') return await hashPath(loc.destPath) === await hashPath(rendered.srcPath);
    if (kind === 'file') return await hashPath(loc.destPath) === hashText(rendered.text);
    if (kind === 'json') {
      const { data } = await readJsonFile(mapping.file);
      const container = getAt(data, mapping.path);
      if (mapping.mode === 'entry') return Boolean(container) && deepEqual(container[loc.name], rendered.value);
      const { total, found } = countHookEntries(container, rendered.value);
      return total > 0 && found === total;
    }
    const found = findBlock(await readTextOrNull(mapping.file), markers(loc));
    return Boolean(found) && blockInner(found) === normalizeInner(rendered.text);
  } catch {
    return false;
  }
}

// ── write ─────────────────────────────────────────────────────────────────────

// rendered: { srcPath } for dirs, { text } for files and blocks, { value } for json.
// Returns { hash, payload? } — payload is stored on the install record.
export async function write(loc, rendered, record = null) {
  const { kind, mapping } = loc;

  if (kind === 'dir') {
    await ensureDir(mapping.base);
    await copyDir(rendered.srcPath, loc.destPath);
    return { hash: await hashPath(loc.destPath) };
  }

  if (kind === 'file') {
    await ensureDir(mapping.base);
    await fs.writeFile(loc.destPath, rendered.text, 'utf8');
    if (mapping.register) await registerPath(mapping.register, loc.destPath, true, loc.backup);
    return { hash: await hashPath(loc.destPath) };
  }

  if (kind === 'json') {
    await editJsonFile(mapping.file, (text) => {
      let t = text;
      if (text.trim() === '') {
        for (const [k, v] of Object.entries(mapping.init || {})) t = setPath(t, [k], v);
      }
      if (mapping.mode === 'entry') {
        const cur = getPath(t, [...mapping.path, loc.name]);
        return deepEqual(cur, rendered.value) && cur !== undefined
          ? t
          : setPath(t, [...mapping.path, loc.name], rendered.value);
      }
      if (record && record.payload) t = removeHookEntries(t, mapping.path, record.payload);
      for (const [event, entries] of Object.entries(rendered.value)) {
        for (const entry of entries) t = arrayAppend(t, [...mapping.path, event], entry);
      }
      return t;
    }, loc.backup);
    return mapping.mode === 'entry'
      ? { hash: hashValue(rendered.value) }
      : { hash: hashValue(rendered.value), payload: rendered.value };
  }

  // block: only the lines between morf's markers are ever touched.
  assertNoMarker(loc, rendered.text);
  const m = markers(loc);
  const inner = normalizeInner(rendered.text);
  const text = await readTextOrNull(mapping.file);
  const eol = text && text.includes('\r\n') ? '\r\n' : '\n';
  const blockLines = [m.begin, ...inner.split('\n'), m.end];
  const found = findBlock(text, m);
  let next;
  if (found) {
    const { lines, b, e } = found;
    if (mapping.style === 'toml') assertNoForeignTable([...lines.slice(0, b), ...lines.slice(e + 1)], inner, mapping.file);
    const cr = eol === '\r\n' ? '\r' : '';
    // The end marker keeps the line ending it already had (none, if it is the
    // last line of a file without a final newline).
    const tail = lines[e].endsWith('\r') ? '\r' : '';
    const replaced = blockLines.map((l, i) => l + (i === blockLines.length - 1 ? tail : cr));
    next = [...lines.slice(0, b), ...replaced, ...lines.slice(e + 1)].join('\n');
  } else {
    if (mapping.style === 'toml' && text) assertNoForeignTable(text.split('\n'), inner, mapping.file);
    const body = blockLines.join(eol);
    if (text == null || text === '') next = body + eol;
    // One blank line, then the block. A file that ended with a newline still
    // does; a file that did not is not given one.
    else if (text.endsWith('\n')) next = text + eol + body + eol;
    else next = text + eol + eol + body;
  }
  if (next !== text) {
    if (loc.backup && text != null) await backupOnce(mapping.file);
    await atomicWrite(mapping.file, next);
  }
  return { hash: hashText(inner) };
}

// ── remove ────────────────────────────────────────────────────────────────────

export async function remove(loc, record = null) {
  const { kind, mapping } = loc;

  if (kind === 'dir' || kind === 'file') {
    await removePath(loc.destPath);
    if (kind === 'file' && mapping.register) await registerPath(mapping.register, loc.destPath, false, loc.backup);
    return;
  }

  if (kind === 'json') {
    if (await readTextOrNull(mapping.file) === null) return;
    await editJsonFile(mapping.file, (text) => {
      if (mapping.mode === 'entry') return removeJsonPath(text, [...mapping.path, loc.name]);
      if (!record || !record.payload) return text;
      return removeHookEntries(text, mapping.path, record.payload);
    }, loc.backup);
    return;
  }

  const text = await readTextOrNull(mapping.file);
  const found = findBlock(text, markers(loc));
  if (!found) return;
  const { lines, b, e } = found;
  // Also take the single blank line morf put in front of the block.
  const start = b > 0 && stripCr(lines[b - 1]) === '' ? b - 1 : b;
  const kept = lines.slice(0, start);
  // When the block ended the file (no final newline), the line break in front
  // of it was morf's too — including the CR of a CRLF pair.
  if (e === lines.length - 1 && start < b && kept.length > 0) {
    kept[kept.length - 1] = stripCr(kept[kept.length - 1]);
  }
  const next = [...kept, ...lines.slice(e + 1)].join('\n');
  if (loc.backup) await backupOnce(mapping.file);
  await atomicWrite(mapping.file, next);
}

// Add or remove a file path in a JSON array (e.g. opencode.json "instructions").
// With `relativeTo`, the path is stored relative to that directory.
async function registerPath({ file, key, relativeTo }, path, present, backup = false) {
  const entry = (relativeTo ? relative(relativeTo, path) : path).replace(/\\/g, '/');
  if (!present && await readTextOrNull(file) === null) return;
  await editJsonFile(file, (text) => {
    if (present) return arrayAppend(text, [key], entry);
    const t = arrayRemove(text, [key], entry);
    const left = getPath(t, [key]);
    return t !== text && Array.isArray(left) && left.length === 0 ? removeJsonPath(t, [key]) : t;
  }, backup);
}

// ── disk scan (list --all) ────────────────────────────────────────────────────

async function isSkillDir(dirPath) {
  try { await fs.access(join(dirPath, 'SKILL.md')); return true; }
  catch { return false; }
}

// Everything found in a target's install locations, managed or not.
// Returns [{ type, name, target }]. Merged hooks and text blocks are anonymous
// on disk, so only skills, file-based items and MCP entries are discoverable.
export async function scanDisk(targetName, scope = null) {
  const profile = tableFor(scope)[targetName];
  if (!profile) return [];
  const items = [];
  const seen = new Set();
  const add = (type, name) => {
    const key = `${type}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ type, name, target: targetName });
  };

  for (const [type, mapping] of Object.entries(profile.types)) {
    if (!mapping) continue;
    try {
      if (mapping.kind === 'dir') {
        for (const entry of await fs.readdir(mapping.base, { withFileTypes: true })) {
          if (entry.isDirectory() && await isSkillDir(join(mapping.base, entry.name))) add(type, entry.name);
        }
      } else if (mapping.kind === 'file') {
        const prefix = mapping.prefix || '';
        for (const entry of await fs.readdir(mapping.base, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(mapping.ext) || !entry.name.startsWith(prefix)) continue;
          const name = entry.name.slice(prefix.length, -mapping.ext.length);
          if (name) add(type, name);
        }
      } else if (mapping.kind === 'json' && mapping.mode === 'entry') {
        const { data } = await readJsonFile(mapping.file);
        const container = getAt(data, mapping.path);
        if (container && typeof container === 'object') {
          for (const name of Object.keys(container)) add(type, name);
        }
      }
    } catch {
      // A missing directory or an unreadable config file should not break `list`.
      continue;
    }
  }
  return items;
}
