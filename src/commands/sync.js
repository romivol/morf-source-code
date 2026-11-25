// morf sync, and morf update in a project.
//
// Returns an exit code (0 or 1) and never calls process.exit; the terminal
// comes through ctx.io, so the command can be tested without a real TTY.
//
//   ctx: { root, cwd, io, morfVersion }

import { assertGitAvailable, openClone } from '../repo/git.js';
import { scanRepo } from '../repo/scan.js';
import { readManifest, writeManifest, recordsFor } from '../install/install-record.js';
import { readConfig } from '../util/config.js';
import { resolveStoredRepo } from '../repo/url.js';
import {
  emptyLock, readProjectFile, readLockfile, writeLockfile, desiredItems,
  findLockSource, findLockItem, lockItems, unlockItem, sourceKey,
} from '../project/project-file-and-lockfile.js';
import { prepare, safeOrName } from '../install/engine.js';
import {
  lockHashOf, tripleKey, findItem, toAction,
  applyActions, applyPrunes, doubleRuleWarnings, closeAll,
} from '../project/plan.js';
import { approve, printPlan, defaultIo } from '../project/approve.js';
import { log } from '../util/log.js';
import { project as P } from '../util/messages.js';

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
