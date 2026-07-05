import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureDir } from './fsops.js';
import { log } from './log.js';

const MANIFEST_DIR  = join(homedir(), '.morf');
const MANIFEST_PATH = join(MANIFEST_DIR, 'installed.json');
const LEGACY_MANIFEST_PATH = join(homedir(), '.ray', 'installed.json');

const EMPTY = () => ({ version: 2, items: {} });

// Migrate a v1 manifest (type:name keys) to v2 (type:name:target keys).
// v1 only ever wrote to "claude", so that's the safe default.
function migrateV1(v1) {
  const upgraded = { version: 2, items: {} };
  for (const [key, record] of Object.entries(v1.items)) {
    const parts = key.split(':');
    if (parts.length === 2) {
      const target = record.target || 'claude';
      upgraded.items[`${key}:${target}`] = { ...record, target };
    } else {
      upgraded.items[key] = record;
    }
  }
  return upgraded;
}

export async function readManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.items !== 'object') {
      throw new Error('Invalid manifest shape');
    }
    if (parsed.version === 1) {
      const migrated = migrateV1(parsed);
      await writeManifest(migrated);
      log.warn('Manifest format updated to support multiple targets (claude, opencode).');
      return migrated;
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // One-time silent migration from the legacy ~/.ray manifest.
      try {
        const legacyRaw = await fs.readFile(LEGACY_MANIFEST_PATH, 'utf8');
        const legacy = JSON.parse(legacyRaw);
        if (legacy && typeof legacy === 'object' && typeof legacy.items === 'object') {
          const upgraded = legacy.version === 1 ? migrateV1(legacy) : legacy;
          await writeManifest(upgraded);
          return upgraded;
        }
      } catch { /* no legacy manifest either */ }
      return EMPTY();
    }
    log.warn(`Manifest is corrupt or unreadable — backing it up and starting fresh. (${err.message})`);
    try {
      await fs.rename(MANIFEST_PATH, MANIFEST_PATH + '.bak.' + Date.now());
    } catch { /* best-effort */ }
    return EMPTY();
  }
}

export async function writeManifest(manifest) {
  await ensureDir(MANIFEST_DIR);
  const tmp = MANIFEST_PATH + '.tmp.' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(tmp, MANIFEST_PATH);
}

export function manifestKey(type, name, target) {
  return `${type}:${name}:${target}`;
}

export function getRecord(manifest, type, name, target) {
  return manifest.items[manifestKey(type, name, target)];
}

export function setRecord(manifest, record) {
  manifest.items[manifestKey(record.type, record.name, record.target)] = record;
}

export function deleteRecord(manifest, type, name, target) {
  delete manifest.items[manifestKey(type, name, target)];
}

export function allRecords(manifest) {
  return Object.values(manifest.items);
}

// Backward-compat accessors: old records have only 'hash'; new ones have both.
export function getInstalledHash(record) {
  return record.installedHash ?? record.hash;
}

export function getSourceHash(record) {
  return record.sourceHash ?? record.hash;
}
