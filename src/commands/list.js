import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { readManifest, allRecords, getInstalledHash, getSourceHash } from '../manifest.js';
import { resolveDestination, listTargets } from '../targets.js';
import { scanDisk, scanRepo } from '../scan.js';
import { withTempClone, assertGitAvailable } from '../git.js';
import { hashPath } from '../fsops.js';
import { sanitizeName } from '../sanitize.js';
import { log, tintWithHex, isAscii } from '../log.js';
import { renderTable } from '../table.js';
import { parseAgentFrontmatter } from '../convert.js';
import * as M from '../messages.js';

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

  // With --all-on-disk, also discover items present on disk but not tracked in
  // the manifest — they fold into the same pivot table as unmanaged rows.
  const unmanaged = [];
  if (allOnDisk) {
    const managedKeys = new Set(records.map(r => `${r.type}:${r.name}:${r.target}`));
    const targetsToScan = target ? [target] : listTargets();
    for (const t of targetsToScan) {
      for (const item of await scanDisk(t)) {
        if (!managedKeys.has(`${item.type}:${item.name}:${item.target}`)) unmanaged.push(item);
      }
    }
  }

  if (withStatus.length === 0 && unmanaged.length === 0) {
    log.info(M.listEmpty);
    return;
  }

  renderPivot(withStatus, unmanaged, checkUpdates, repoHashes);
}

// Collapse a source repo/path for the SOURCE column. Git remotes shrink to
// owner/repo (via shortRepo); long local filesystem paths collapse to the last
// two path segments prefixed with an ellipsis.
function shortSource(repoOrKey) {
  const raw = String(repoOrKey || '');
  const isLocal = raw.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(raw);
  if (isLocal) {
    const norm = raw.replace(/\\/g, '/');
    if (norm.length > 28) {
      const parts = norm.split('/').filter(Boolean);
      return '…/' + parts.slice(-2).join('/');
    }
    return norm;
  }
  return shortRepo(raw);
}

// Status symbol for a single managed record within its tool column.
function cellSymbol(r, checkUpdates, repoHashes) {
  if (!r.present) return log.TAG.miss();
  if (r.onDiskHash !== getInstalledHash(r)) return log.TAG.mod();
  if (checkUpdates) {
    const groupKey = `${r.repoKey}\x00${r.ref || ''}`;
    const repoHash = (repoHashes.get(groupKey) || new Map()).get(`${r.type}:${r.name}`);
    if (repoHash && repoHash !== getSourceHash(r)) return log.TAG.upd();
  }
  return log.TAG.ok();
}

// Pivot table: one row per unique item (type + name + source repo), one column
// per tool that has at least one item installed, with a status symbol per cell.
function renderPivot(managed, unmanaged, checkUpdates, repoHashes) {
  const emptyCell = log.meta(isAscii() ? '-' : '—');
  const unmanagedCell = log.meta(isAscii() ? '[?]' : '?');

  // Build one row group per (type, name, source).
  const groups = new Map();
  const order = () => groups.size;
  function group(type, name, sourceKey) {
    const key = `${type}\x00${name}\x00${sourceKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { type, name, sourceKey, cells: new Map(), updated: '', color: null, ord: order() };
      groups.set(key, g);
    }
    return g;
  }

  for (const r of managed) {
    const sourceKey = r.repoKey || r.repo || '';
    const g = group(r.type, r.name, `repo:${sourceKey}`);
    g.source = shortSource(sourceKey);
    g.cells.set(r.target, cellSymbol(r, checkUpdates, repoHashes));
    const date = r.present && r.installedAt ? r.installedAt.slice(0, 10) : '';
    if (date > g.updated) g.updated = date;
    if (r.type === 'agent' && r.meta && r.meta.color) g.color = r.meta.color;
  }

  for (const item of unmanaged) {
    const g = group(item.type, item.name, 'unmanaged');
    g.source = '(unmanaged)';
    g.cells.set(item.target, unmanagedCell);
  }

  const rowGroups = [...groups.values()];

  // Tool columns: only targets that appear in at least one row, in listTargets order.
  const present = new Set(rowGroups.flatMap(g => [...g.cells.keys()]));
  const tools = listTargets().filter(t => present.has(t));

  // Disambiguate exact (type, name) collisions from different sources.
  const nameCounts = new Map();
  for (const g of rowGroups) {
    const k = `${g.type}\x00${g.name}`;
    nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
  }

  rowGroups.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  const columns = [
    { header: 'NAME' },
    { header: 'TYPE' },
    ...tools.map(t => ({ header: t.toUpperCase(), align: 'center' })),
    { header: 'SOURCE' },
    { header: 'UPDATED' },
  ];

  const rows = rowGroups.map(g => {
    let nameCell = g.color ? tintWithHex(g.name, g.color) : g.name;
    if (nameCounts.get(`${g.type}\x00${g.name}`) > 1 && g.source) {
      nameCell = `${nameCell} (${g.source})`;
    }
    return [
      nameCell,
      g.type,
      ...tools.map(t => g.cells.get(t) || emptyCell),
      g.source || '',
      g.updated || '',
    ];
  });

  renderTable(columns, rows);
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
