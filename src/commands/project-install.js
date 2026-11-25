// morf install in a project.
//
// Returns an exit code (0 or 1) and never calls process.exit; the terminal
// comes through ctx.io, so the command can be tested without a real TTY.
//
//   ctx: { root, cwd, io, morfVersion }

import { assertGitAvailable, openClone, scanClone } from '../repo/git.js';
import { expandTargets } from '../install/targets.js';
import { readManifest, writeManifest } from '../install/install-record.js';
import { readConfig, resolveRepo } from '../util/config.js';
import { cleanRepoForProject } from '../repo/url.js';
import {
  emptyProject, emptyLock, readProjectFile, writeProjectFile, readLockfile,
  writeLockfile, findLockSource, findLockItem, lockItems, addToProject,
} from '../project/project-file-and-lockfile.js';
import { prepare, selectItems, safeOrName } from '../install/engine.js';
import { lockHashOf, toAction, applyActions, doubleRuleWarnings } from '../project/plan.js';
import { approve, printPlan, defaultIo } from '../project/approve.js';
import { log, printable } from '../util/log.js';
import { assertSafeRef } from '../repo/validate.js';
import { project as P } from '../util/messages.js';

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

  let pf;
  let lock;
  try {
    if (args.ref) assertSafeRef(args.ref);
    pf = (await readProjectFile(root)) || emptyProject();
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
    log.err(printable(e.message));
    return 1;
  }

  try {
    if (!ref) ref = clone.branch;
    if (!ref) { log.err(`Could not tell which branch ${printable(repo)} is on. Pass --ref <branch>.`); return 1; }
    assertSafeRef(ref);

    const available = await scanClone(clone.dir);
    const { selected, missing } = selectItems(available, args.names, args.all);
    for (const m of missing) {
      log.err(locked ? P.notInPinned(m.type, m.name, repo, clone.commit)
                     : `${m.type} '${printable(m.name)}' not found in ${printable(repo)}; available: ${m.available.length ? printable(m.available.join(', ')) : '(none)'}`);
    }
    if (missing.length) return 1;
    if (selected.length === 0) { log.info(`Nothing to install from ${printable(repo)}.`); return 0; }

    const manifest = await readManifest();
    const lockEntries = [];
    const actions = [];
    for (const item of selected) {
      if (item.invalid) { log.err(`${item.type} '${printable(item.name)}': ${printable(item.invalid)}`); return 1; }
      const name = safeOrName(item.name);
      const hash = await lockHashOf(item);
      const prior = findLockItem(locked, item.type, name);
      if (prior && prior.hash !== hash) { log.err(P.hashMismatch(item.type, name, repo)); return 1; }
      lockEntries.push({ type: item.type, name, hash });
      for (const target of targets) {
        let prep;
        try {
          prep = await prepare(item, { target, manifest, force: args.force, config, scope, sourceHash: hash });
        } catch (e) {
          log.err(`${item.type} '${printable(name)}' (${target}): ${printable(e.message)}`);
          return 1;
        }
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
      for (const a of edited) log.info(`    ${a.target}  ${a.type}  ${printable(a.name)}`);
    }
    return failed > 0 ? 1 : 0;
  } finally {
    await clone.close();
  }
}
