// Project mode: commands that run inside a morf project (a directory tree with
// a morf.json). Everything installs under the project root, the project file
// and lockfile are kept in step, and nothing changes without approval.
//
// Every command here returns an exit code (0 or 1) instead of calling
// process.exit, and takes its terminal through `ctx.io`, so it can be tested
// without a real TTY.
//
//   ctx: { root, cwd, io, morfVersion }

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { assertGitAvailable, openClone } from '../repo/git.js';
import { scanRepo, TYPES } from '../repo/scan.js';
import { expandTargets, READS_ROOT_AGENTS_MD } from '../install/targets.js';
import { portableHashPath } from '../util/fs.js';
import { hashValue } from '../install/json-file.js';
import { readManifest, writeManifest, recordsFor } from '../install/install-record.js';
import { readConfig, resolveRepo } from '../util/config.js';
import { cleanRepoForProject, resolveStoredRepo } from '../repo/url.js';
import {
  PROJECT_FILE, LOCK_FILE, emptyProject, emptyLock, readProjectFile, writeProjectFile,
  readLockfile, writeLockfile, desiredItems, findLockSource, findLockItem,
  lockItems, unlockItem, addToProject, removeFromProject, sourceKey,
} from '../project/project-file-and-lockfile.js';
import { prepare, commit, removeInstalled, selectItems, safeOrName } from './install.js';
import { approve, printPlan, execCommands, defaultIo } from '../project/approve.js';
import { log } from '../util/log.js';
import { createTargetTable } from '../util/table.js';
import { project as P, notInstalled } from '../util/messages.js';

// ── shared helpers ────────────────────────────────────────────────────────────

// The lockfile hash of a source item: portable across machines.
export async function lockHashOf(item) {
  if (item.payload !== undefined) return 'sha256:' + hashValue(item.payload);
  return portableHashPath(item.srcPath);
}

const tripleKey = (type, name, target) => `${type}:${name}:${target}`;

function findItem(available, type, name) {
  return available.find(i => i.type === type && safeOrName(i.name) === safeOrName(name)) || null;
}

// Turn a prepared item into a plan action.
function toAction(prep, { item, target, repo, commit: sha, force }) {
  const base = { target, type: item.type, name: prep.safeName, repo, commit: sha, prep, item };
  const exec = (item.type === 'hook' || item.type === 'mcp') ? execCommands(item) : undefined;
  switch (prep.status) {
    case 'unsupported': return { ...base, op: 'unsupported', reason: `unsupported (${prep.reason})` };
    case 'modified':
      return {
        ...base, op: 'skip', edited: true,
        reason: `${prep.edited ? 'edited locally' : 'already exists, not installed by morf'} (use --force to overwrite)`,
      };
    case 'current':
    case 'adopt': return { ...base, op: 'current' };
    case 'install': return { ...base, op: 'install', exec };
    default: return { ...base, op: prep.overwrite && force ? 'overwrite' : 'replace', exec };
  }
}

// Carry out the approved actions. Returns { done, failed }.
async function applyActions(actions, { manifest, scope, refOf }) {
  const todo = actions.filter(a => ['install', 'replace', 'overwrite'].includes(a.op));
  const adopt = actions.filter(a => a.op === 'current' && a.prep.status === 'adopt');
  let done = 0;
  let failed = 0;

  // Items already in place only need their install record written.
  for (const a of adopt) {
    try {
      await commit(a.prep, { repo: a.repo, target: a.target, manifest, ref: refOf(a), scope, commit: a.commit });
    } catch { /* an unreadable adopted item is reported on the next run */ }
  }

  if (todo.length === 0) return { done, failed };
  const table = createTargetTable(todo.map(a => a.target), todo.map(a => a.name));
  table.header();
  for (const a of todo) {
    try {
      const { tagName, note } =
        await commit(a.prep, { repo: a.repo, target: a.target, manifest, ref: refOf(a), scope, commit: a.commit });
      table.row(a.target, a.name, log.TAG[tagName](), note);
      done++;
    } catch (e) {
      table.row(a.target, a.name, log.TAG.fail(), e.message);
      failed++;
    }
  }
  return { done, failed };
}

async function applyPrunes(prunes, manifest) {
  let failed = 0;
  if (prunes.length === 0) return failed;
  const table = createTargetTable(prunes.map(a => a.target), prunes.map(a => a.name));
  table.header();
  for (const a of prunes) {
    try {
      await removeInstalled(manifest, a.record);
      table.row(a.target, a.name, log.TAG.ok(), 'removed');
    } catch (e) {
      table.row(a.target, a.name, log.TAG.fail(), e.message);
      failed++;
    }
  }
  return failed;
}

// Rules for Codex land in the root AGENTS.md, which other tools also read.
function doubleRuleWarnings(desired) {
  const out = [];
  for (const d of desired) {
    if (d.type !== 'rule' || !d.targets.includes('codex')) continue;
    const also = d.targets.filter(t => READS_ROOT_AGENTS_MD.includes(t));
    if (also.length) out.push(P.doubleRule(d.name, also));
  }
  return out;
}

async function closeAll(clones) {
  await Promise.all([...clones.values()].map(c => c.close()));
}

// ── morf init ─────────────────────────────────────────────────────────────────

export async function initCommand(ctx) {
  const path = join(ctx.cwd, PROJECT_FILE);
  if (existsSync(path)) {
    log.err(P.initExists(path));
    return 1;
  }
  await writeProjectFile(ctx.cwd, emptyProject());
  log.ok(P.initDone(path));
  return 0;
}

// ── morf sync / morf update ───────────────────────────────────────────────────
//
// sync    makes the project match the lockfile (pinned commits)
// update  moves every source to the tip of its ref, then does the same
//
// flags: { frozen, check, prune, force, yes, allowExec, dryRun, update }
export async function syncCommand(flags, ctx) {
  const { root } = ctx;
  const io = ctx.io || defaultIo();
  const scope = { project: root };
  const update = Boolean(flags.update);
  // --frozen is the default in CI. It never applies to `update` or `--check`.
  const frozen = !update && (Boolean(flags.frozen) || Boolean(io.env.CI));
  const check = Boolean(flags.check);

  const pf = await readProjectFile(root);
  if (!pf) { log.err(P.noProject); return 1; }
  let lock;
  try {
    lock = await readLockfile(root);
  } catch (e) {
    log.err(e.message);
    return 1;
  }

  const desired = desiredItems(pf);
  const hadLock = lock !== null;
  const working = hadLock ? JSON.parse(JSON.stringify(lock)) : emptyLock();

  // Declaration drift: project file vs lockfile.
  const isLocked = d => Boolean(findLockItem(findLockSource(working, d.repo, d.ref), d.type, d.name));
  const newItems = desired.filter(d => !isLocked(d));
  const wanted = new Set(desired.map(d => `${sourceKey(d)}\x00${d.type}:${d.name}`));
  const extra = [];
  for (const s of working.sources) {
    for (const i of s.items) {
      if (!wanted.has(`${sourceKey(s)}\x00${i.type}:${i.name}`)) extra.push({ repo: s.repo, ref: s.ref, type: i.type, name: i.name });
    }
  }

  if (frozen && !check) {
    if (!hadLock) { log.err(P.frozenNoLock); return 1; }
    if (newItems.length || extra.length) { log.err(P.frozenDrift); return 1; }
  }

  await assertGitAvailable();
  const config = await readConfig();
  const manifest = await readManifest();
  const clones = new Map();

  try {
    // ── validate: fetch every source and check it against the lockfile ──────
    // Any failure here means nothing at all is changed.
    const bySource = new Map();
    for (const d of desired) {
      const key = sourceKey(d);
      if (!bySource.has(key)) bySource.set(key, { repo: d.repo, ref: d.ref, items: [] });
      bySource.get(key).items.push(d);
    }

    const resolved = new Map();   // sourceKey -> { commit, available }
    for (const [key, src] of bySource) {
      const locked = findLockSource(working, src.repo, src.ref);
      const pinned = locked && !update;
      // --check has no business fetching sources that are not locked yet.
      if (check && !locked) continue;
      let clone;
      try {
        clone = await openClone(resolveStoredRepo(src.repo, root),
          pinned ? { commit: locked.commit, label: src.repo } : { ref: src.ref, label: src.repo });
      } catch (e) {
        log.err(e.message);
        return 1;
      }
      clones.set(key, clone);
      const available = await scanRepo(clone.dir);
      resolved.set(key, { commit: clone.commit, available, pinned });

      for (const d of src.items) {
        const item = findItem(available, d.type, d.name);
        const lockItem = findLockItem(locked, d.type, d.name);
        if (!item) {
          log.err(pinned ? P.notInPinned(d.type, d.name, src.repo, clone.commit)
                         : `${d.type} '${d.name}' was not found in ${src.repo} (${src.ref}).`);
          return 1;
        }
        if (item.invalid) { log.err(`${d.type} '${d.name}' in ${src.repo}: ${item.invalid}`); return 1; }
        const hash = await lockHashOf(item);
        if (pinned && lockItem && lockItem.hash !== hash) {
          log.err(P.hashMismatch(d.type, d.name, src.repo));
          return 1;
        }
        d.item = item;
        d.hash = hash;
        d.commit = clone.commit;
      }
      if (!check) lockItems(working, { repo: src.repo, ref: src.ref, commit: clone.commit },
        src.items.map(d => ({ type: d.type, name: d.name, hash: d.hash })));
    }

    // ── plan ────────────────────────────────────────────────────────────────
    const actions = [];
    const desiredTriples = new Set();
    for (const d of desired) {
      for (const target of d.targets) {
        desiredTriples.add(tripleKey(d.type, safeOrName(d.name), target));
        if (!d.item) continue;   // --check, source not locked yet: reported as declaration drift
        const prep = await prepare(d.item, {
          target, manifest, force: flags.force, config, scope, sourceHash: d.hash,
        });
        actions.push(toAction(prep, { item: d.item, target, repo: d.repo, commit: d.commit, force: flags.force }));
      }
    }
    // Installed for this project, but no longer asked for.
    for (const r of recordsFor(manifest, root)) {
      if (desiredTriples.has(tripleKey(r.type, r.name, r.target))) continue;
      actions.push({ op: 'prune', target: r.target, type: r.type, name: r.name, record: r, reason: 'no longer in the lockfile' });
    }

    // ── --check: report drift, change nothing ───────────────────────────────
    if (check) return reportDrift({ hadLock, newItems, extra, actions });

    printPlan(root, actions, doubleRuleWarnings(desired));

    // --dry-run: the plan is all there is. No questions, no changes, exit 0.
    if (flags.dryRun) { log.dim(P.dryRun); return 0; }

    const edited = actions.filter(a => a.op === 'skip');
    if (frozen && edited.length > 0) {
      log.err(P.frozenEdited);
      return 1;
    }

    // ── approve, then apply ─────────────────────────────────────────────────
    const decision = await approve(actions, { ...flags, frozen }, io);
    if (!decision.apply) return 1;

    const refOf = a => desired.find(d => d.item === a.item)?.ref || null;
    const { failed } = await applyActions(actions, { manifest, scope, refOf });

    const prunes = actions.filter(a => a.op === 'prune');
    let pruneFailed = 0;
    if (decision.prune) pruneFailed = await applyPrunes(prunes, manifest);

    await writeManifest(manifest);

    if (!frozen) {
      // Lockfile entries the project file no longer asks for go once their
      // installed copies are gone (pruned, or never installed here).
      const stillInstalled = new Set(recordsFor(manifest, root).map(r => `${r.type}:${r.name}`));
      for (const x of extra) {
        if (!stillInstalled.has(`${x.type}:${safeOrName(x.name)}`)) unlockItem(working, x.repo, x.ref, x.type, x.name);
      }
      await writeLockfile(root, working, ctx.morfVersion);
    }

    if (edited.length > 0) {
      log.warn(P.skippedEdited(edited.length));
      for (const a of edited) log.info(`    ${a.target}  ${a.type}  ${a.name}`);
    }
    if (prunes.length > 0 && !decision.prune) log.info(P.pruneKept(prunes.length));
    return failed + pruneFailed > 0 ? 1 : 0;
  } finally {
    await closeAll(clones);
  }
}

// The two kinds of drift, reported separately. Returns the exit code.
function reportDrift({ hadLock, newItems, extra, actions }) {
  const decl = [];
  if (!hadLock && newItems.length > 0) decl.push('there is no lockfile');
  for (const d of newItems) decl.push(`${d.type} '${d.name}' (${d.repo}) is in the project file but not in the lockfile`);
  for (const x of extra) decl.push(`${x.type} '${x.name}' (${x.repo}) is in the lockfile but not in the project file`);

  const disk = [];
  for (const a of actions) {
    if (a.op === 'install') disk.push(`${a.target}: ${a.type} '${a.name}' is not installed`);
    else if (a.op === 'replace' || a.op === 'overwrite') disk.push(`${a.target}: ${a.type} '${a.name}' differs from the lockfile`);
    else if (a.op === 'skip') disk.push(`${a.target}: ${a.type} '${a.name}' was edited locally`);
    else if (a.op === 'prune') disk.push(`${a.target}: ${a.type} '${a.name}' is installed but not in the lockfile`);
  }

  if (decl.length === 0 && disk.length === 0) {
    log.ok(P.noDrift);
    return 0;
  }
  if (decl.length) {
    log.bold(P.driftDeclHeader);
    for (const l of decl) log.info(`  ${l}`);
  }
  if (disk.length) {
    log.bold(P.driftDiskHeader);
    for (const l of disk) log.info(`  ${l}`);
  }
  for (const a of actions.filter(x => x.op === 'unsupported')) {
    log.dim(`  note: ${a.target}: ${a.type} '${a.name}' is ${a.reason}`);
  }
  return 1;
}

// ── morf install (project mode) ───────────────────────────────────────────────
//
// args: { repoArg, names, all, targets, force, ref, yes, allowExec }
export async function projectInstallCommand(args, ctx) {
  const { root, cwd } = ctx;
  const io = ctx.io || defaultIo();
  const scope = { project: root };

  const config = await readConfig();
  let cleaned;
  try {
    cleaned = cleanRepoForProject(resolveRepo(args.repoArg, config), root, cwd);
  } catch (e) {
    log.err(e.message);
    return 1;
  }
  const repo = cleaned.stored;
  const targets = expandTargets(args.targets);

  const pf = (await readProjectFile(root)) || emptyProject();
  let lock;
  try {
    lock = (await readLockfile(root)) || emptyLock();
  } catch (e) {
    log.err(e.message);
    return 1;
  }

  // Which ref? The flag, else the one this repo already uses here, else the
  // repo's default branch.
  let ref = args.ref || null;
  if (!ref) {
    const refs = [...new Set(pf.sources.filter(s => s.repo === repo).map(s => s.ref))];
    if (refs.length === 1) ref = refs[0];
  }
  // A source that is already locked stays pinned: new items come from the same
  // commit, so installing one thing never silently moves the others.
  const locked = ref ? findLockSource(lock, repo, ref) : null;

  await assertGitAvailable();
  let clone;
  try {
    clone = await openClone(cleaned.cloneUrl, locked ? { commit: locked.commit, label: repo } : { ref, label: repo });
  } catch (e) {
    log.err(e.message);
    return 1;
  }

  try {
    if (!ref) ref = clone.branch;
    if (!ref) { log.err(`Could not tell which branch ${repo} is on. Pass --ref <branch>.`); return 1; }

    const available = await scanRepo(clone.dir);
    const { selected, missing } = selectItems(available, args.names, args.all);
    for (const m of missing) {
      log.err(locked ? P.notInPinned(m.type, m.name, repo, clone.commit)
                     : `${m.type} '${m.name}' not found in ${repo}; available: ${m.available.length ? m.available.join(', ') : '(none)'}`);
    }
    if (missing.length) return 1;
    if (selected.length === 0) { log.info(`Nothing to install from ${repo}.`); return 0; }

    const manifest = await readManifest();
    const lockEntries = [];
    const actions = [];
    for (const item of selected) {
      if (item.invalid) { log.err(`${item.type} '${item.name}': ${item.invalid}`); return 1; }
      const name = safeOrName(item.name);
      const hash = await lockHashOf(item);
      const prior = findLockItem(locked, item.type, name);
      if (prior && prior.hash !== hash) { log.err(P.hashMismatch(item.type, name, repo)); return 1; }
      lockEntries.push({ type: item.type, name, hash });
      for (const target of targets) {
        const prep = await prepare(item, { target, manifest, force: args.force, config, scope, sourceHash: hash });
        actions.push(toAction(prep, { item, target, repo, commit: clone.commit, force: args.force }));
      }
    }

    const warnings = [];
    if (cleaned.local) warnings.push(P.localSource(repo));
    warnings.push(...doubleRuleWarnings(lockEntries.map(e => ({ ...e, targets }))));
    printPlan(root, actions, warnings);
    if (args.dryRun) { log.dim(P.dryRun); return 0; }

    const decision = await approve(actions, args, io);
    if (!decision.apply) return 1;

    const { failed } = await applyActions(actions, { manifest, scope, refOf: () => ref });
    await writeManifest(manifest);

    await writeProjectFile(root, addToProject(pf, { repo, ref }, lockEntries, targets));
    await writeLockfile(root, lockItems(lock, { repo, ref, commit: clone.commit }, lockEntries), ctx.morfVersion);

    const edited = actions.filter(a => a.op === 'skip');
    if (edited.length > 0) {
      log.warn(P.skippedEdited(edited.length));
      for (const a of edited) log.info(`    ${a.target}  ${a.type}  ${a.name}`);
    }
    return failed > 0 ? 1 : 0;
  } finally {
    await clone.close();
  }
}

// ── morf uninstall (project mode) ─────────────────────────────────────────────
//
// args: { names, all, targets, yes, allowExec }
export async function projectUninstallCommand(args, ctx) {
  const { root } = ctx;
  const io = ctx.io || defaultIo();

  const pf = (await readProjectFile(root)) || emptyProject();
  let lock;
  try {
    lock = (await readLockfile(root)) || emptyLock();
  } catch (e) {
    log.err(e.message);
    return 1;
  }
  const manifest = await readManifest();
  const records = recordsFor(manifest, root);
  const desired = desiredItems(pf);

  const only = expandTargets(args.targets);
  const targetOk = t => only.length === 0 || only.includes(t);

  // What to remove: (type, name, target) triples, from the install record and
  // from the project file (an item may be listed but not installed here).
  const triples = new Map();
  const add = (type, name, target, record = null) => {
    if (!targetOk(target)) return;
    const key = tripleKey(type, name, target);
    const cur = triples.get(key) || { type, name, target, record: null };
    if (record) cur.record = record;
    triples.set(key, cur);
  };
  const matches = (type, name) => args.all ||
    (args.names[type] || []).some(n => safeOrName(n) === name);

  for (const r of records) if (matches(r.type, r.name)) add(r.type, r.name, r.target, r);
  for (const d of desired) {
    if (matches(d.type, safeOrName(d.name))) for (const t of d.targets) add(d.type, safeOrName(d.name), t);
  }

  if (!args.all) {
    for (const type of TYPES) {
      for (const n of args.names[type] || []) {
        const name = safeOrName(n);
        if (![...triples.values()].some(t => t.type === type && t.name === name)) log.info(notInstalled(n));
      }
    }
  }
  if (triples.size === 0) return 0;

  const actions = [...triples.values()].map(t => ({
    op: 'remove', target: t.target, type: t.type, name: t.name, record: t.record,
    reason: t.record ? null : 'listed in the project file, not installed here',
    exec: [],
  }));
  printPlan(root, actions);
  if (args.dryRun) { log.dim(P.dryRun); return 0; }

  const decision = await approve(actions, args, io);
  if (!decision.apply) return 1;

  let failed = 0;
  const installed = actions.filter(a => a.record);
  if (installed.length) {
    const table = createTargetTable(installed.map(a => a.target), installed.map(a => a.name));
    table.header();
    for (const a of installed) {
      try {
        await removeInstalled(manifest, a.record);
        table.row(a.target, a.name, log.TAG.ok(), 'removed');
      } catch (e) {
        table.row(a.target, a.name, log.TAG.fail(), e.message);
        failed++;
      }
    }
  }
  await writeManifest(manifest);

  let nextPf = pf;
  for (const a of actions) {
    // The project file stores names as written; match on the sanitized form.
    const original = desired.find(d => d.type === a.type && safeOrName(d.name) === a.name);
    nextPf = removeFromProject(nextPf, a.type, original ? original.name : a.name, [a.target]);
  }
  await writeProjectFile(root, nextPf);

  // An item leaves the lockfile once no tool in the project file wants it.
  const stillWanted = new Set(desiredItems(nextPf).map(d => `${sourceKey(d)}\x00${d.type}:${d.name}`));
  for (const s of lock.sources) {
    for (const i of [...s.items]) {
      if (!stillWanted.has(`${sourceKey(s)}\x00${i.type}:${i.name}`)) unlockItem(lock, s.repo, s.ref, i.type, i.name);
    }
  }
  if (lock.sources.length > 0 || existsSync(join(root, LOCK_FILE))) {
    await writeLockfile(root, lock, ctx.morfVersion);
  }

  return failed > 0 ? 1 : 0;
}
