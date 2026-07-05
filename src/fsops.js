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
