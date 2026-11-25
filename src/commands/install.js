import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { assertGitAvailable, withTempClone } from '../repo/git.js';
import { scanRepo, TYPES } from '../repo/scan.js';
import { expandTargets, targetScope } from '../install/targets.js';
import { sanitizeName } from '../util/sanitize.js';
import { hashPath, removePath } from '../util/fs.js';
import {
  readManifest, writeManifest, getRecord, setRecord, deleteRecord, recordsFor,
  getInstalledHash, getSourceHash,
} from '../install/install-record.js';
import { readConfig, resolveRepo } from '../util/config.js';
import { normalizeRepo } from '../repo/url.js';
import { adaptAgentForTarget } from '../convert/agents.js';
import { convertRule, convertPrompt, convertHook, convertMcp } from '../convert/primitives.js';
import { locate, currentHash, matchesRendered, write, remove, sourceHashOf } from '../install/store.js';
import { log } from '../util/log.js';
import { createTargetTable } from '../util/table.js';
import * as M from '../util/messages.js';

const NOTE_INDENT = '         '; // 9 spaces

// Bumped whenever a converter's output changes, so items installed by an older
// morf are re-rendered on the next install/update even if the source is unchanged.
export const CONVERTER_VERSION = 2;

// Sanitized name for display; falls back to the raw name if it can't be sanitized.
export function safeOrName(name) {
  try { return sanitizeName(name); } catch { return name; }
}

// Pick the items a command asked for out of what a repo offers.
// Returns { selected, missing: [{ type, name, available }] }.
export function selectItems(available, names, all) {
  if (all) return { selected: dedupeBySafeName(available), missing: [] };
  const selected = [];
  const missing = [];
  for (const type of TYPES) {
    const ofType = available.filter(i => i.type === type);
    for (const name of names[type] || []) {
      const found = ofType.find(i => i.name === name) ||
        ofType.find(i => safeOrName(i.name) === safeOrName(name));
      if (found) selected.push(found);
      else missing.push({ type, name, available: ofType.map(i => i.name) });
    }
  }
  return { selected: dedupeBySafeName(selected), missing };
}

export async function installCommand(args) {
  const { repoArg, names, all, targets, force, ref, dryRun } = args;

  const config = await readConfig();
  const repo = resolveRepo(repoArg, config);

  await assertGitAvailable();

  const counts = { installed: 0, updated: 0, upToDate: 0, skipped: 0, failed: 0 };
  const concreteTargets = expandTargets(targets);

  await withTempClone(repo, ref, async (cloneDir) => {
    const available = await scanRepo(cloneDir);

    if (available.length === 0 && all) {
      log.info(M.err.emptyRepo(repo));
      return;
    }

    const { selected, missing } = selectItems(available, names, all);
    for (const m of missing) {
      log.miss(m.name);
      log.dim(`${NOTE_INDENT}error: ${m.type} '${m.name}' not found in repo; available: ${m.available.length ? m.available.join(', ') : '(none)'}`);
      counts.failed++;
    }

    const manifest = await readManifest();

    const selectedNames = selected.map(i => safeOrName(i.name));
    const table = (!dryRun && selected.length > 0)
      ? createTargetTable(concreteTargets, selectedNames)
      : null;
    if (table) table.header();

    for (const concreteTarget of concreteTargets) {
      const projectScoped = targetScope(concreteTarget) === 'project';

      for (const item of selected) {
        const rowName = safeOrName(item.name);
        try {
          const { result, tagName, note } =
            await installOne(item, { repo, target: concreteTarget, manifest, force, ref, dryRun, config });
          countResult(counts, result);
          if (table && tagName) {
            const trailing = note || (projectScoped ? '(project-scoped)' : null);
            table.row(concreteTarget, rowName, log.TAG[tagName](), trailing);
          }
        } catch (e) {
          if (table) table.row(concreteTarget, rowName, log.TAG.fail(), e.message);
          else { log.err(`${item.name} (${concreteTarget})`); log.dim(`${NOTE_INDENT}error: ${e.message}`); }
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

// Produce what will be stored for `item` in `loc`'s native format.
// Returns { srcPath } | { text, notes } | { value, notes } | { unsupported }.
export async function render(item, loc, config = null) {
  const { target, name, mapping } = loc;
  if (mapping.kind === 'dir') return { srcPath: item.srcPath, notes: [] };

  if (item.type === 'hook') return convertHook(item.payload, target, { name });
  // An MCP entry in a file several tools read (.mcp.json) is written once, in
  // the shape all of them accept.
  if (item.type === 'mcp') return convertMcp(item.payload, loc.shared ? 'copilot' : target, { name });

  const sourceText = await fs.readFile(item.srcPath, 'utf8');

  if (item.type === 'agent') {
    // `morf config convert off` copies agents verbatim — except where the
    // target's agent format is not Markdown at all.
    const convert = (config ? config.convertTools !== false : true) || mapping.ext !== '.md';
    if (!convert) return { text: sourceText, notes: [] };
    const { text, changed, notes } =
      adaptAgentForTarget(sourceText, target, { name, asRule: Boolean(mapping.asRule) });
    return { text, notes: changed ? (notes.length ? notes : ['frontmatter']) : [] };
  }
  if (item.type === 'rule') return convertRule(sourceText, target, { name });
  if (item.type === 'prompt') return convertPrompt(sourceText, target);

  return { text: sourceText, notes: [] };
}

// Other tools' records for the same physical item (a shared destination such as
// .agents/skills/<name> or a .mcp.json entry).
export function coOwners(manifest, loc, project, target) {
  if (!loc.shared) return [];
  return recordsFor(manifest, project).filter(r =>
    r.target !== target && r.type === loc.type && r.name === loc.name && r.physical === loc.physical);
}

// Work out what installing `item` for one target would do, without writing.
//
// Returns { status, ... } where status is one of
//   'unsupported'  the target has no place for this item (reason)
//   'modified'     on disk, but edited locally or not installed by morf (reason)
//   'current'      installed and identical — nothing to do
//   'adopt'        already on disk exactly as morf would write it, but with no
//                  install record for this target: only the record is missing
//   'install'      not there yet
//   'replace'      there, managed, and different from the source
//
// Options: repo, target, manifest, force, config — plus, in project mode:
//   scope       { project: root }; null means a global install
//   sourceHash  the lockfile hash to record (default: sourceHashOf(item))
export async function prepare(item, options) {
  const { target, manifest, force, config = null, scope = null } = options;
  const project = scope ? scope.project : '';

  if (item.invalid) throw new Error(item.invalid);
  const safeName = sanitizeName(item.name);

  let loc;
  try {
    loc = locate(target, item.type, safeName, scope);
  } catch (e) {
    if (e.unsupported) return { status: 'unsupported', reason: e.unsupported, safeName };
    throw e;
  }

  const existing = getRecord(manifest, item.type, safeName, target, project);
  const onDiskHash = await currentHash(loc, existing);
  const destExists = onDiskHash !== null;
  const repoHash = options.sourceHash || await sourceHashOf(item);

  const crossNote = TYPES
    .filter(t => t !== item.type && getRecord(manifest, t, safeName, target, project))
    .map(t => `a ${t} named '${safeName}' is also installed`)[0] || null;

  const base = { loc, existing, safeName, repoHash, onDiskHash, crossNote, item };

  // A co-owner (another tool sharing this destination) may already have put
  // the item there; that is not a local edit.
  const owners = coOwners(manifest, loc, project, target);
  const owner = owners.find(r => getInstalledHash(r) === onDiskHash) || null;

  const existingInstalledHash = existing ? getInstalledHash(existing) : null;
  let isLocallyModified = destExists && (!existing || onDiskHash !== existingInstalledHash);
  let rendered = null;

  if (isLocallyModified && !existing) {
    if (owner) {
      isLocallyModified = false;
      if (getSourceHash(owner) === repoHash && owner.conv === CONVERTER_VERSION) {
        return { ...base, status: 'adopt', payload: owner.payload };
      }
    } else if (scope) {
      // Project mode: tool files may be committed to the repository, so a fresh
      // clone has them on disk with no install record. If they are exactly what
      // morf would write, they are simply installed already.
      rendered = await render(item, loc, config);
      if (rendered.unsupported) return { ...base, status: 'unsupported', reason: rendered.unsupported };
      if (await matchesRendered(loc, rendered)) {
        return { ...base, status: 'adopt', payload: rendered.value };
      }
    }
  }

  if (isLocallyModified && !force) {
    const why = existing ? 'local changes' : 'already exists (not installed by morf)';
    return { ...base, status: 'modified', reason: why, edited: Boolean(existing) };
  }

  const existingSourceHash = existing ? getSourceHash(existing) : null;
  const converterCurrent = loc.kind === 'dir' || (existing && existing.conv === CONVERTER_VERSION);
  if (destExists && existing && !isLocallyModified && repoHash === existingSourceHash && converterCurrent) {
    return { ...base, status: 'current' };
  }

  if (!rendered) rendered = await render(item, loc, config);
  if (rendered.unsupported) return { ...base, status: 'unsupported', reason: rendered.unsupported };

  const isUpdate = destExists && (Boolean(existing) || Boolean(owner));
  return { ...base, status: isUpdate ? 'replace' : 'install', rendered, isUpdate, destExists, overwrite: isLocallyModified };
}

// Carry out a prepared 'install' / 'replace' / 'adopt' and update the install
// record. Returns { result, tagName, note }.
export async function commit(prep, options) {
  const { repo, target, manifest, ref, scope = null } = options;
  const project = scope ? scope.project : '';
  const { loc, existing, safeName, repoHash, item, crossNote } = prep;

  let hash;
  let payload;
  if (prep.status === 'adopt') {
    hash = prep.onDiskHash === 'partial' || prep.onDiskHash === null
      ? await currentHash(loc, { payload: prep.payload })
      : prep.onDiskHash;
    payload = prep.payload;
  } else {
    let written;
    try {
      written = await write(loc, prep.rendered, existing);
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(M.err.permission(loc.destPath));
      throw e;
    }
    hash = written.hash;
    payload = written.payload;
    if (existing && !prep.destExists) await removePreviousLocation(loc, existing);
  }

  const record = {
    type: item.type,
    name: safeName,
    repo,
    repoKey: normalizeRepo(repo),
    target,
    project,
    hash,
    sourceHash: repoHash,
    installedHash: hash,
    conv: CONVERTER_VERSION,
    ref: ref || null,
    installedAt: new Date().toISOString(),
  };
  if (payload !== undefined) record.payload = payload;
  if (loc.shared) record.physical = loc.physical;
  if (options.commit) record.commit = options.commit;
  setRecord(manifest, record);

  // Keep co-owners of a shared item in step, or they would see morf's own
  // write as a local edit.
  if (prep.status !== 'adopt') {
    for (const r of coOwners(manifest, loc, project, target)) {
      r.hash = hash;
      r.installedHash = hash;
      r.sourceHash = repoHash;
      r.conv = CONVERTER_VERSION;
      if (options.commit) r.commit = options.commit;
    }
  }

  if (prep.status === 'adopt') return { result: 'up-to-date', tagName: 'ok', note: crossNote };

  const notes = [...(prep.rendered.notes || [])];
  if (item.type === 'hook' && target === 'codex') notes.push('approve it with /hooks in Codex');
  const adaptNote = notes.length ? `adapted for ${target}: ${notes.join('; ')}` : null;

  const note = [adaptNote, crossNote].filter(Boolean).join('; ') || null;
  if (adaptNote) return { result: prep.isUpdate ? 'updated' : 'installed', tagName: 'warn', note };
  if (prep.isUpdate) return { result: 'updated', tagName: 'upd', note };
  return { result: 'installed', tagName: 'ok', note };
}

// Remove an installed item and its record. A shared item is deleted from disk
// only when no other tool still owns it. Returns true when it was deleted.
export async function removeInstalled(manifest, record) {
  const project = record.project || '';
  const loc = locate(record.target, record.type, record.name, project ? { project } : null);
  const others = coOwners(manifest, loc, project, record.target);
  if (others.length === 0) await remove(loc, record);
  deleteRecord(manifest, record.type, record.name, record.target, project);
  return others.length === 0;
}

// Install or update a single item.
// Returns { result, tagName, note } where result is one of
//   'installed' | 'updated' | 'up-to-date' | 'skipped'
// tagName is the status symbol to render (or null in dry-run, which prints its
// own line) and note is an optional short dimmed trailing fragment.
//
// Options:
//   repo, target, manifest, force, ref, dryRun — the resolved install context
//   config  — loaded morf config (controls agent conversion); defaults to null
export async function installOne(item, options) {
  const { target, ref, dryRun } = options;
  const prep = await prepare(item, options);
  const { safeName } = prep;

  if (prep.status === 'unsupported') {
    if (dryRun) { log.info(M.dry.wouldSkipUnsupported(safeName, target)); return { result: 'skipped', tagName: null, note: null }; }
    return { result: 'skipped', tagName: 'mod', note: prep.reason };
  }

  if (prep.status === 'modified') {
    if (dryRun) {
      log.info(M.dry.wouldSkip(safeName));
      return { result: 'skipped', tagName: null, note: null };
    }
    return { result: 'skipped', tagName: 'mod', note: `${prep.reason} — re-run with --force` };
  }

  if (prep.status === 'current') {
    if (dryRun) {
      log.info(M.dry.alreadyCurrent(safeName));
      return { result: 'up-to-date', tagName: null, note: null };
    }
    if (ref && ref !== prep.existing.ref) {
      prep.existing.ref = ref;
      prep.existing.installedAt = new Date().toISOString();
    }
    return { result: 'up-to-date', tagName: 'ok', note: prep.crossNote };
  }

  if (dryRun) {
    if (prep.status === 'adopt') { log.info(M.dry.alreadyCurrent(safeName)); return { result: 'up-to-date', tagName: null, note: null }; }
    log.info(prep.isUpdate ? M.dry.wouldUpdate(prep.item.type, safeName, prep.loc.display)
                           : M.dry.wouldInstall(prep.item.type, safeName, prep.loc.display));
    return { result: prep.isUpdate ? 'updated' : 'installed', tagName: null, note: null };
  }

  return commit(prep, options);
}

// Older morf versions wrote some items elsewhere (e.g. Cursor agents as
// .cursor/rules/<name>.mdc). When the item moves, remove the old copy — but
// only if it is still exactly what morf installed.
async function removePreviousLocation(loc, existing) {
  const prev = loc.mapping.previous;
  if (!prev) return;
  const oldPath = join(prev.base, loc.name + prev.ext);
  try {
    if (await hashPath(oldPath) === getInstalledHash(existing)) await removePath(oldPath);
  } catch { /* nothing at the old location */ }
}
