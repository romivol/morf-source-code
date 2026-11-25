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
  // Remove existing destination first for a clean overwrite.
  await removePath(dst);
  await fs.cp(src, dst, { recursive: true });
}

// Deterministic sha256 of a file or directory.
// For dirs: sort relative paths, hash relpath + NUL + content per file.
export async function hashPath(p) {
  const stat = await fs.stat(p);
  if (stat.isFile()) {
    return hashFile(p);
  }
  if (stat.isDirectory()) {
    return hashDir(p);
  }
  throw new Error(`hashPath: unsupported file type at ${p}`);
}

async function hashFile(p) {
  const buf = await fs.readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function hashDir(dir) {
  const entries = await collectFiles(dir);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash('sha256');
  for (const { rel, abs } of entries) {
    const buf = await fs.readFile(abs);
    // Deterministic separator between path and content.
    h.update(rel).update('\0').update(buf).update('\0');
  }
  return h.digest('hex');
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
  const stat = await fs.stat(p);
  if (stat.isFile()) {
    return portableDigest([{ rel: '', buf: await fs.readFile(p) }]);
  }
  const files = await collectFiles(p);
  const entries = [];
  for (const { rel, abs } of files) entries.push({ rel, buf: await fs.readFile(abs) });
  return portableDigest(entries);
}

// Recursively collect all files under dir as { rel, abs }.
async function collectFiles(dir) {
  const results = [];
  async function walk(current) {
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      const abs = join(current, item.name);
      if (item.isDirectory()) {
        await walk(abs);
      } else if (item.isFile()) {
        results.push({ rel: relative(dir, abs), abs });
      }
    }
  }
  await walk(dir);
  return results;
}
