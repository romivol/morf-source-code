// The install record: ~/.morf/installed.json — what is installed on this machine.
// (Internally still called the "manifest"; users only ever see "install record".)

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureDir } from './fsops.js';
import { log } from './log.js';

const MANIFEST_DIR  = join(homedir(), '.morf');
const MANIFEST_PATH = join(MANIFEST_DIR, 'installed.json');
const LEGACY_MANIFEST_PATH = join(homedir(), '.ray', 'installed.json');

const CURRENT_VERSION = 3;
const EMPTY = () => ({ version: CURRENT_VERSION, items: {} });

// v1 (type:name keys) -> v2 (type:name:target keys).
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

// v2 -> v3: every record gains a `project` field (the project root it was
// installed into). Records written before projects existed are global installs.
function migrateV2(v2) {
  const upgraded = { version: CURRENT_VERSION, items: {} };
  for (const record of Object.values(v2.items)) {
    if (!record || typeof record !== 'object') continue;
    const r = { ...record, project: typeof record.project === 'string' ? record.project : '' };
    upgraded.items[manifestKey(r.type, r.name, r.target, r.project)] = r;
  }
  return upgraded;
}

// Bring any older shape up to the current one. Returns { manifest, migrated }.
export function upgradeManifest(parsed) {
  let m = parsed;
  let migrated = false;
  if (m.version === 1) { m = migrateV1(m); migrated = true; }
  if (m.version !== CURRENT_VERSION) { m = migrateV2(m); migrated = true; }
  return { manifest: m, migrated };
}

export async function readManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.items !== 'object') {
      throw new Error('Invalid install record shape');
    }
    const { manifest, migrated } = upgradeManifest(parsed);
    if (migrated) await writeManifest(manifest);
    return manifest;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // One-time silent migration from the legacy ~/.ray install record.
      try {
        const legacyRaw = await fs.readFile(LEGACY_MANIFEST_PATH, 'utf8');
        const legacy = JSON.parse(legacyRaw);
        if (legacy && typeof legacy === 'object' && typeof legacy.items === 'object') {
          const { manifest } = upgradeManifest(legacy);
          await writeManifest(manifest);
          return manifest;
        }
      } catch { /* no legacy record either */ }
      return EMPTY();
    }
    log.warn(`The install record is corrupt or unreadable — backing it up and starting fresh. (${err.message})`);
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

// `project` is the project root for a project install, '' for a global one.
// Global keys keep their old shape so nothing moves for existing users.
export function manifestKey(type, name, target, project = '') {
  return project ? `${type}:${name}:${target}@${project}` : `${type}:${name}:${target}`;
}

export function getRecord(manifest, type, name, target, project = '') {
  return manifest.items[manifestKey(type, name, target, project)];
}

export function setRecord(manifest, record) {
  const r = { ...record, project: record.project || '' };
  manifest.items[manifestKey(r.type, r.name, r.target, r.project)] = r;
  return r;
}

export function deleteRecord(manifest, type, name, target, project = '') {
  delete manifest.items[manifestKey(type, name, target, project)];
}

export function allRecords(manifest) {
  return Object.values(manifest.items);
}

// Records belonging to one scope: a project root, or '' for global installs.
export function recordsFor(manifest, project = '') {
  return allRecords(manifest).filter(r => (r.project || '') === project);
}

// Backward-compat accessors: old records have only 'hash'; new ones have both.
export function getInstalledHash(record) {
  return record.installedHash ?? record.hash;
}

export function getSourceHash(record) {
  return record.sourceHash ?? record.hash;
}
