import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { assertGitAvailable, withTempClone } from '../git.js';
import { scanRepo } from '../scan.js';
import { resolveDestination, expandTargets, targetScope } from '../targets.js';
import { sanitizeName, assertPathInside } from '../sanitize.js';
import { ensureDir, copyDir, hashPath } from '../fsops.js';
import { readManifest, writeManifest, getRecord, setRecord, getInstalledHash, getSourceHash } from '../manifest.js';
import { readConfig, resolveRepo } from '../config.js';
import { normalizeRepo } from '../source.js';
import { adaptAgentForTarget } from '../convert.js';
import { log } from '../log.js';
import * as M from '../messages.js';

const NOTE_INDENT = '         '; // 9 spaces

export async function installCommand(args) {
  const { repoArg, skills, agents, all, target, force, ref, dryRun } = args;

  const config = await readConfig();
  const repo = resolveRepo(repoArg, config);

  await assertGitAvailable();

  const counts = { installed: 0, updated: 0, upToDate: 0, skipped: 0, failed: 0 };
  const concreteTargets = expandTargets(target);
  const multiTarget = concreteTargets.length > 1;

  await withTempClone(repo, ref, async (cloneDir) => {
    const available = await scanRepo(cloneDir);

    if (available.length === 0 && all) {
      log.info(M.err.emptyRepo(repo));
      return;
    }

    let selected;
    if (all) {
      selected = available;
    } else {
      selected = [];
      const skillNames = available.filter(i => i.type === 'skill').map(i => i.name);
      const agentNames = available.filter(i => i.type === 'agent').map(i => i.name);

      for (const name of skills) {
        const found = available.find(i => i.type === 'skill' && i.name === name);
        if (found) selected.push(found);
        else {
          log.miss(name);
          log.dim(`${NOTE_INDENT}error: skill '${name}' not found in repo; available: ${skillNames.length ? skillNames.join(', ') : '(none)'}`);
          counts.failed++;
        }
      }
      for (const name of agents) {
        const found = available.find(i => i.type === 'agent' && i.name === name);
        if (found) selected.push(found);
        else {
          log.miss(name);
          log.dim(`${NOTE_INDENT}error: agent '${name}' not found in repo; available: ${agentNames.length ? agentNames.join(', ') : '(none)'}`);
          counts.failed++;
        }
      }
    }

    selected = dedupeBySafeName(selected);

    const manifest = await readManifest();
    const newlyInstalled = [];

    for (const concreteTarget of concreteTargets) {
      if (multiTarget) log.header(`\n*** ${concreteTarget} ***`);
      if (targetScope(concreteTarget) === 'project') {
        log.dim(`  (${concreteTarget} is project-scoped — installing into the current directory)`);
      }

      for (const item of selected) {
        try {
          const result = await installOne(item, { repo, target: concreteTarget, manifest, force, ref, dryRun, config });
          countResult(counts, result);
          if (!dryRun && result === 'installed') {
            newlyInstalled.push({ name: sanitizeName(item.name), type: item.type });
          }
        } catch (e) {
          log.err(item.name);
          log.dim(`${NOTE_INDENT}error: ${e.message}`);
          counts.failed++;
        }
      }
    }

    if (!dryRun) {
      await writeManifest(manifest);
    }
  });

  if (dryRun) {
    log.dim(M.dry.previewDone);
    return;
  }

  printSummary(counts);
  if (counts.failed > 0) process.exit(1);
}

function dedupeBySafeName(items) {
  const seen = new Map();
  const out = [];
  for (const item of items) {
    let safe;
    try { safe = sanitizeName(item.name); } catch { continue; }
    const key = `${item.type}:${safe}`;
    if (seen.has(key)) {
      log.warn(
        `name collision after sanitization: '${seen.get(key)}' and '${item.name}' ` +
        `both map to '${safe}'; skipping the latter.`
      );
      continue;
    }
    seen.set(key, item.name);
    out.push(item);
  }
  return out;
}

export function countResult(counts, result) {
  if (result === 'installed') counts.installed++;
  else if (result === 'updated') counts.updated++;
  else if (result === 'up-to-date') counts.upToDate++;
  else if (result === 'skipped') counts.skipped++;
}

export function printSummary(counts) {
  const line = M.installSummary(counts);
  if (!line) return;
  log.info(line);
  if (counts.skipped > 0) log.dim(M.installSkippedHint);
}

// Install or update a single item.
// Returns one of: 'installed' | 'updated' | 'up-to-date' | 'skipped'.
//
// Options:
//   repo, target, manifest, force, ref, dryRun — the resolved install context
//   config  — loaded morf config (controls agent conversion); defaults to null
//   prefix  — optional string prepended to per-item status lines (e.g. '[2/5] ')
export async function installOne(item, options) {
  const { repo, target, manifest, force, ref, dryRun, config = null, prefix = '' } = options;
  let mapping;
  try {
    mapping = resolveDestination(target, item.type);
  } catch (e) {
    if (e.message.includes('does not support')) {
      log.warn(`${prefix}${e.message.split('.')[0]} (skipping ${item.name})`);
      return 'skipped';
    }
    throw e;
  }

  const safeName = sanitizeName(item.name);
  const { kind, base, ext } = mapping;
  const destPath = kind === 'dir' ? join(base, safeName) : join(base, safeName + ext);
  assertPathInside(base, destPath);

  const existing = getRecord(manifest, item.type, safeName, target);

  let destExists = false;
  let onDiskHash = null;
  try {
    await fs.access(destPath);
    destExists = true;
    onDiskHash = await hashPath(destPath);
  } catch { /* dest doesn't exist */ }

  const otherType = item.type === 'skill' ? 'agent' : 'skill';
  if (getRecord(manifest, otherType, safeName, target)) {
    log.info(`note: a ${otherType} named '${safeName}' is also installed.`);
  }

  const existingInstalledHash = existing ? getInstalledHash(existing) : null;
  const isLocallyModified = destExists && (!existing || onDiskHash !== existingInstalledHash);
  if (isLocallyModified && !force) {
    if (dryRun) {
      log.info(`${prefix}${M.dry.wouldSkip(safeName)}`);
    } else {
      log.mod(`${prefix}${safeName}`);
      log.dim(`${NOTE_INDENT}note: has local changes — re-run with --force to overwrite`);
    }
    return 'skipped';
  }

  const repoHash = await hashPath(item.srcPath);
  const existingSourceHash = existing ? getSourceHash(existing) : null;
  if (destExists && existing && !isLocallyModified && repoHash === existingSourceHash) {
    if (dryRun) {
      log.info(`${prefix}${M.dry.alreadyCurrent(safeName)}`);
    } else {
      if (ref && ref !== existing.ref) {
        existing.ref = ref;
        existing.installedAt = new Date().toISOString();
      }
      log.ok(`${prefix}${safeName}`);
    }
    return 'up-to-date';
  }

  const isUpdate = destExists && existing;

  if (dryRun) {
    log.info(prefix + (isUpdate ? M.dry.wouldUpdate(item.type, safeName, destPath)
                                : M.dry.wouldInstall(item.type, safeName, destPath)));
    return isUpdate ? 'updated' : 'installed';
  }

  try {
    await ensureDir(base);
    if (kind === 'dir') await copyDir(item.srcPath, destPath);
    else                await fs.copyFile(item.srcPath, destPath);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(M.err.permission(destPath));
    throw e;
  }

  // For agent files, optionally convert the tools format.
  let installedHash = repoHash;
  let adaptNote = null;
  const shouldAdapt = kind === 'file' && item.type === 'agent' && (config ? config.convertTools !== false : true);
  if (shouldAdapt) {
    try {
      const sourceText = await fs.readFile(item.srcPath, 'utf8');
      const { text: adaptedText, changed, notes } = adaptAgentForTarget(sourceText, target);
      if (changed) {
        await fs.writeFile(destPath, adaptedText, 'utf8');
        installedHash = await hashPath(destPath);
        const summary = notes.length ? ` (${notes.join('; ')})` : '';
        adaptNote = `note: adapted agent for ${target}${summary}`;
      }
    } catch {
      // fallback: leave the copied file unchanged
    }
  }

  setRecord(manifest, {
    type: item.type,
    name: safeName,
    repo,
    repoKey: normalizeRepo(repo),
    target,
    hash: installedHash,
    sourceHash: repoHash,
    installedHash,
    ref: ref || null,
    installedAt: new Date().toISOString(),
  });

  if (adaptNote) {
    log.warn(`${prefix}${safeName}`);
    log.dim(`${NOTE_INDENT}${adaptNote}`);
  } else if (isUpdate) {
    log.upd(`${prefix}${safeName}`);
  } else {
    log.ok(`${prefix}${safeName}`);
  }
  return isUpdate ? 'updated' : 'installed';
}
