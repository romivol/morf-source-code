import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { readManifest, allRecords, getInstalledHash, getSourceHash } from '../manifest.js';
import { resolveDestination, listTargets } from '../targets.js';
import { scanDisk, scanRepo } from '../scan.js';
import { withTempClone, assertGitAvailable } from '../git.js';
import { hashPath } from '../fsops.js';
import { sanitizeName } from '../sanitize.js';
import { log, tintWithHex } from '../log.js';
import { parseAgentFrontmatter } from '../convert.js';
import * as M from '../messages.js';

const NAME_W = 20;
const REPO_W = 20;
const TYPES_ORDER = ['skill', 'agent'];
const TYPE_LABELS = { skill: 'skills', agent: 'agents' };

export function shortRepo(repoOrKey) {
  if (!repoOrKey) return '';
  const s = String(repoOrKey);

  // Local paths — return as-is
  if (s.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(s)) return s;

  let path;

  // HTTPS: https://host/path[.git]
  const httpsMatch = s.match(/^https?:\/\/[^/]+\/(.*?)(?:\.git)?\/?$/);
  if (httpsMatch) {
    path = httpsMatch[1];
  } else if (s.includes(':') && !s.includes('://')) {
    // SSH SCP: [user@]host:path[.git]
    const sshMatch = s.match(/^(?:[^@/]+@)?[^/:]+:(.*?)(?:\.git)?\/?$/);
    if (sshMatch) path = sshMatch[1];
  }

  if (path !== undefined) {
    const parts = path.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('/') : parts.join('/') || s;
  }

  // Already normalized host/path repoKey — strip the host component
  const slashIdx = s.indexOf('/');
  if (slashIdx !== -1) {
    const afterHost = s.slice(slashIdx + 1).replace(/\.git$/, '');
    const parts = afterHost.split('/').filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join('/');
    if (parts.length === 1) return afterHost;
  }

  return s;
}

export async function listCommand(opts = {}) {
  const { allOnDisk, target, checkUpdates } = opts;

  const manifest = await readManifest();
  let records = allRecords(manifest);

  if (target) records = records.filter(r => r.target === target);

  if (records.length === 0 && !allOnDisk) {
    log.info(M.listEmpty);
    return;
  }

  const withStatus = await Promise.all(records.map(async (r) => {
    let present = false;
    let onDiskHash = null;
    let destPath = null;
    let meta = null;
    try {
      const { kind, base, ext } = resolveDestination(r.target, r.type);
      destPath = kind === 'dir' ? join(base, r.name) : join(base, r.name + ext);
      await fs.access(destPath);
      present = true;
      onDiskHash = await hashPath(destPath);
      if (r.type === 'agent' && kind === 'file') {
        try {
          const content = await fs.readFile(destPath, 'utf8');
          meta = parseAgentFrontmatter(content, r.name);
        } catch { /* leave meta null */ }
      }
    } catch { /* missing or unsupported */ }
    return { ...r, present, onDiskHash, destPath, meta };
  }));

  const repoHashes = new Map();
  if (checkUpdates && withStatus.length > 0) {
    await assertGitAvailable();
    log.info(M.listCheckingHeader);
    const groups = groupByRepoRef(withStatus);
    const groupList = [...groups.entries()];
    let checked = 0;
    for (const [groupKey, group] of groupList) {
      checked++;
      if (process.stdout.isTTY) {
        process.stdout.write(`\rChecking ${checked}/${groupList.length} repos...  `);
      } else {
        process.stdout.write(`Checking ${checked}/${groupList.length} repos...\n`);
      }
      const itemHashes = new Map();
      try {
        await withTempClone(group.repo, group.ref, async (cloneDir) => {
          const available = await scanRepo(cloneDir);
          for (const item of available) {
            try {
              itemHashes.set(`${item.type}:${sanitizeName(item.name)}`, await hashPath(item.srcPath));
            } catch { /* skip */ }
          }
        });
      } catch (e) {
        log.warn(`Could not check ${group.repo}: ${e.message}`);
      }
      repoHashes.set(groupKey, itemHashes);
    }
    if (groupList.length > 0 && process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }
  }

  if (withStatus.length > 0) {
    if (allOnDisk) log.info(M.listManagedHeader);
    renderGrouped(withStatus, checkUpdates, repoHashes);
  } else if (!allOnDisk) {
    log.info(M.listEmpty);
    return;
  }

  if (!allOnDisk) return;

  const managedKeys = new Set(records.map(r => `${r.type}:${r.name}:${r.target}`));
  const targetsToScan = target ? [target] : listTargets();
  const unmanaged = [];
  for (const t of targetsToScan) {
    for (const item of await scanDisk(t)) {
      if (!managedKeys.has(`${item.type}:${item.name}:${item.target}`)) unmanaged.push(item);
    }
  }

  log.info(M.listUnmanagedHeader);
  if (unmanaged.length === 0) {
    log.info(M.listUnmanagedNone);
  } else {
    renderGroupedUnmanaged(unmanaged);
  }
}

function renderGrouped(items, checkUpdates, repoHashes) {
  for (const targetName of listTargets()) {
    const targetItems = items.filter(r => r.target === targetName);
    if (targetItems.length === 0) continue;

    log.header(`\n*** ${targetName} ***`);

    for (const typeName of TYPES_ORDER) {
      const typeItems = targetItems
        .filter(r => r.type === typeName)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (typeItems.length === 0) continue;

      log.dim(`  ${TYPE_LABELS[typeName]}`);

      for (const r of typeItems) {
        log.info(formatRow(r, checkUpdates, repoHashes));
      }
    }
  }
}

function renderGroupedUnmanaged(items) {
  for (const targetName of listTargets()) {
    const targetItems = items.filter(i => i.target === targetName);
    if (targetItems.length === 0) continue;

    log.header(`\n*** ${targetName} ***`);

    for (const typeName of TYPES_ORDER) {
      const typeItems = targetItems
        .filter(i => i.type === typeName)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (typeItems.length === 0) continue;

      log.dim(`  ${TYPE_LABELS[typeName]}`);

      for (const item of typeItems) {
        log.info(`    ${M.GLYPH.bullet} ${item.name}`);
      }
    }
  }
}

function groupByRepoRef(records) {
  const groups = new Map();
  for (const r of records) {
    if (!r.repo) continue;
    const key = `${r.repoKey}\x00${r.ref || ''}`;
    if (!groups.has(key)) groups.set(key, { repo: r.repo, ref: r.ref || null });
  }
  return groups;
}

function formatRow(r, checkUpdates, repoHashes) {
  let statusTag;
  if (!r.present) statusTag = log.PADDED.miss();
  else if (r.onDiskHash !== getInstalledHash(r)) statusTag = log.PADDED.mod();
  else statusTag = log.PADDED.ok();

  const repoBase = shortRepo(r.repoKey || r.repo || '');
  const repoDisplay = r.ref ? `${repoBase}@${r.ref}` : repoBase;
  const note = r.present ? (r.installedAt ? r.installedAt.slice(0, 10) : '') : '(missing from disk)';

  // Name display: tint with hex color for agents that have a color field.
  const visibleName = r.name;
  let displayName = visibleName;
  if (r.type === 'agent' && r.meta && r.meta.color) {
    displayName = tintWithHex(visibleName, r.meta.color);
  }
  // Pad manually so ANSI codes don't inflate the measured width.
  const namePadded = displayName + ' '.repeat(Math.max(0, NAME_W - visibleName.length));

  let suffix = '';
  if (checkUpdates) {
    if (!r.present) suffix = `  ${M.LIST_STATUS.missingFromDisk}`;
    else if (r.onDiskHash !== getInstalledHash(r)) suffix = `  ${M.LIST_STATUS.locallyModified}`;
    else {
      const groupKey = `${r.repoKey}\x00${r.ref || ''}`;
      const repoHash = (repoHashes.get(groupKey) || new Map()).get(`${r.type}:${r.name}`);
      suffix = `  ${repoHash && repoHash !== getSourceHash(r) ? M.LIST_STATUS.updateAvailable : M.LIST_STATUS.upToDate}`;
    }
  }

  // statusTag is 7 chars (bracket + padding + separator space) — no extra space needed.
  return `    ${statusTag}${namePadded} ${repoDisplay.padEnd(REPO_W)} ${note}${suffix}`;
}
