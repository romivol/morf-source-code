// Tolerant JSON(C) reading, atomic writing and canonical hashing for the shared
// config files morf merges into (settings.json, mcp.json, opencode.json, ...).
// No external parser: comments and trailing commas are stripped by hand.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './fsops.js';

// Remove // and /* */ comments and trailing commas, leaving string contents intact.
export function stripJsonComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // Trailing commas before } or ] (outside strings).
  let res = '';
  i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      res += out.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') { i++; continue; }
      res += ch;
      i++;
    } else {
      res += ch;
      i++;
    }
  }
  return res;
}

// Parse JSON or JSONC text. Returns { data, hadComments }.
export function parseJsonc(text) {
  const clean = text.replace(/^\uFEFF/, '');
  try {
    return { data: JSON.parse(clean), hadComments: false };
  } catch {
    return { data: JSON.parse(stripJsonComments(clean)), hadComments: true };
  }
}

// Read a JSON(C) config file.
// Missing or empty file -> { data: {}, exists: false }.
// Unparseable file -> throws (callers must never overwrite a file they can't read).
export async function readJsonFile(path) {
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, exists: false, hadComments: false };
    throw err;
  }
  if (raw.trim() === '') return { data: {}, exists: true, hadComments: false };
  let parsed;
  try {
    parsed = parseJsonc(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON, so morf left it untouched (${e.message})`);
  }
  if (typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data)) {
    throw new Error(`${path} does not contain a JSON object, so morf left it untouched`);
  }
  return { data: parsed.data, exists: true, hadComments: parsed.hadComments };
}

// Read a text file; null when it does not exist.
export async function readTextOrNull(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Deterministic JSON for files morf owns outright (morf.json, morf.lock.json):
// object keys sorted, 2-space indent, trailing newline.
export function stableStringify(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
    }
    return v;
  };
  // Small flat objects and lists of plain values stay on one line, which keeps
  // the files short and their diffs readable:
  //   { "name": "bug-finder", "type": "agent" }      ["claude", "cursor"]
  const plain = v => v === null || typeof v !== 'object';
  const fmt = (v, indent, top) => {
    if (plain(v)) return JSON.stringify(v);
    const inner = indent + '  ';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      if (v.every(plain)) return '[' + v.map(x => JSON.stringify(x)).join(', ') + ']';
      return '[\n' + v.map(x => inner + fmt(x, inner, false)).join(',\n') + '\n' + indent + ']';
    }
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    if (!top && keys.every(k => plain(v[k]))) {
      return '{ ' + keys.map(k => `${JSON.stringify(k)}: ${JSON.stringify(v[k])}`).join(', ') + ' }';
    }
    return '{\n' + keys.map(k => `${inner}${JSON.stringify(k)}: ${fmt(v[k], inner, false)}`).join(',\n') + '\n' + indent + '}';
  };
  return fmt(sort(value), '', true) + '\n';
}

export async function atomicWrite(path, text) {
  await ensureDir(dirname(path));
  const tmp = path + '.tmp.' + process.pid;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, path);
}

// Stable stringify (sorted object keys) so equal values hash equally.
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function hashValue(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function deepEqual(a, b) {
  return canonical(a) === canonical(b);
}
