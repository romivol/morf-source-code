// morf uninstall in a project.
//
// Returns an exit code (0 or 1) and never calls process.exit; the terminal
// comes through ctx.io, so the command can be tested without a real TTY.
//
//   ctx: { root, cwd, io, morfVersion }

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { TYPES } from '../repo/scan.js';
import { expandTargets } from '../install/targets.js';
import { readManifest, writeManifest, recordsFor } from '../install/install-record.js';
import {
  LOCK_FILE, emptyProject, emptyLock, readProjectFile, writeProjectFile, readLockfile,
  writeLockfile, desiredItems, unlockItem, removeFromProject, sourceKey,
} from '../project/project-file-and-lockfile.js';
import { removeInstalled, safeOrName } from '../install/engine.js';
import { tripleKey } from '../project/plan.js';
import { approve, printPlan, defaultIo } from '../project/approve.js';
import { log } from '../util/log.js';
import { createTargetTable } from '../util/table.js';
import { project as P, notInstalled } from '../util/messages.js';

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
