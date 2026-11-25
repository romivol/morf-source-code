import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

export async function removePath(p) {
  await fs.rm(p, { recursive: true, force: true });
}

export async function copyDir(src, dst) {
  // Never copy a link, and never let one decide where a copy lands.
  await collectFiles(src, { strict: true });
  // Remove existing destination first for a clean overwrite.
  await removePath(dst);
  await fs.cp(src, dst, { recursive: true });
}

// Deterministic sha256 of a file or directory.
// For dirs: sort relative paths, hash relpath + NUL + content per file.
// `strict` is for content taken from a source repository: a symbolic link (or
// anything else that is not a regular file) is an error there, so that it can
// neither be followed nor left out of the hash.
export async function hashPath(p, { strict = false } = {}) {
  const stat = strict ? await fs.lstat(p) : await fs.stat(p);
  if (strict && stat.isSymbolicLink()) throw new Error(`${p} is a symbolic link`);
  if (stat.isFile()) {
    return hashFile(p);
  }
  if (stat.isDirectory()) {
    return hashDir(p, strict);
  }
  throw new Error(`hashPath: unsupported file type at ${p}`);
}

async function hashFile(p) {
  const buf = await fs.readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function hashDir(dir, strict = false) {
  const entries = await collectFiles(dir, { strict });
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash('sha256');
  for (const { rel, abs } of entries) {
    const buf = await fs.readFile(abs);
    // Deterministic separator between path and content.
    h.update(rel).update('\0').update(buf).update('\0');
  }
  return h.digest('hex');
}

// ── size ──────────────────────────────────────────────────────────────────────

// An item bigger than this is unusual for a skill, agent, rule or prompt. morf
// has no size limit; it warns, so the user sees it before the item lands.
export const LARGE_ITEM_BYTES = 5 * 1024 * 1024;

// Total size in bytes of a file, or of every regular file under a directory.
export async function sizeOf(p) {
  const st = await fs.lstat(p);
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const entry of await fs.readdir(p, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isFile()) total += await sizeOf(join(p, entry.name));
  }
  return total;
}

export function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── portable hashing (project mode / lockfile) ────────────────────────────────
//
// hashPath above is what the install record has always used; it depends on the
// OS path separator and locale sort, which is fine for one machine. A lockfile
// is shared between machines, so its hashes use this instead: forward-slash
// relative paths, byte-order sort, raw file bytes. Callers must hand it a raw
// checkout (see repo/git.js openClone) so the bytes are the ones git stores.

// entries: [{ rel, buf }]. Pure, so tests can feed it either path separator.
export function portableDigest(entries) {
  const norm = entries
    .map(e => ({ rel: Buffer.from(String(e.rel).replace(/\\/g, '/'), 'utf8'), buf: e.buf }))
    .sort((a, b) => Buffer.compare(a.rel, b.rel));
  const h = createHash('sha256');
  for (const { rel, buf } of norm) {
    h.update(rel).update('\0').update(buf).update('\0');
  }
  return 'sha256:' + h.digest('hex');
}

// Portable hash of a file (its bytes) or a directory (every file under it).
export async function portableHashPath(p) {
  // lstat, not stat: a link is never followed. Every entry must be a regular
  // file or a directory, so nothing can be left out of a lockfile hash.
  const stat = await fs.lstat(p);
  if (stat.isSymbolicLink()) throw new Error(`${p} is a symbolic link`);
  if (stat.isFile()) {
    return portableDigest([{ rel: '', buf: await fs.readFile(p) }]);
  }
  const files = await collectFiles(p, { strict: true });
  const entries = [];
  for (const { rel, abs } of files) entries.push({ rel, buf: await fs.readFile(abs) });
  return portableDigest(entries);
}

// Recursively collect all files under dir as { rel, abs }.
// With `strict`, anything that is not a regular file or a directory is an error.
async function collectFiles(dir, { strict = false } = {}) {
  const results = [];
  async function walk(current) {
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      const abs = join(current, item.name);
      if (item.isDirectory()) {
        await walk(abs);
      } else if (item.isFile()) {
        results.push({ rel: relative(dir, abs), abs });
      } else if (strict) {
        const what = item.isSymbolicLink() ? 'a symbolic link' : 'not a regular file';
        throw new Error(`${relative(dir, abs).split('\\').join('/')} is ${what}; morf does not follow or copy links`);
      }
    }
  }
  await walk(dir);
  return results;
}
