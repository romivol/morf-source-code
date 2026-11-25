import { assertGitAvailable, withTempClone, scanClone } from '../repo/git.js';
import { TYPES } from '../repo/scan.js';
import { sanitizeName } from '../util/sanitize.js';
import { expandTargets, targetScope } from '../install/targets.js';
import { readManifest, writeManifest, recordsFor } from '../install/install-record.js';
import { readConfig } from '../util/config.js';
import { log, printable } from '../util/log.js';
import { assertSafeRepo, assertSafeRef } from '../repo/validate.js';
import { createTargetTable } from '../util/table.js';
import { installOne, execToApprove, largeSize } from '../install/engine.js';
import { approveExec, execCommands, defaultIo, isInteractive } from '../project/approve.js';
import { project as P } from '../util/messages.js';
import { countResult, printSummary, describeSkippedExec } from './install.js';
import * as M from '../util/messages.js';

export async function updateCommand(args, io = defaultIo()) {
  const { names, all, targets, force, ref: refOverride, dryRun } = args;

  if (refOverride) assertSafeRef(refOverride);
  let execRefused = false;
  const skippedExec = [];
  const config = await readConfig();

  const manifest = await readManifest();
  const records = recordsFor(manifest, '');   // global installs only; projects have their own commands

  const counts = { installed: 0, updated: 0, upToDate: 0, skipped: 0, failed: 0 };

  let toUpdate = [];
  const unknown = [];

  const concreteTargets = expandTargets(targets);
  const targetFilter = r => concreteTargets.length === 0 || concreteTargets.includes(r.target);

  if (all) {
    toUpdate = records.filter(targetFilter);
  } else {
    const wanted = TYPES.flatMap(type =>
      (names[type] || []).map(n => ({ type, orig: n, name: safeOrNull(n) })));
    for (const w of wanted) {
      if (!w.name) { unknown.push(w); continue; }
      const matches = records.filter(r => r.type === w.type && r.name === w.name && targetFilter(r));
      if (matches.length === 0) unknown.push(w);
      else toUpdate.push(...matches);
    }
  }

  for (const u of unknown) log.info(M.notInstalledForUpdate(u.orig));
  if (toUpdate.length === 0 && unknown.length > 0) counts.failed += unknown.length;

  if (toUpdate.length === 0) {
    if (dryRun) { log.dim(M.dry.previewDone); return; }
    if (!all && unknown.length === 0) log.info('Nothing to update.');
    printSummary(counts);
    if (counts.failed > 0) process.exit(1);
    return;
  }

  // The install record is a file on disk: check what it says before any of it
  // reaches git. A record that fails is reported and left alone.
  const usable = [];
  for (const r of toUpdate) {
    try {
      assertSafeRepo(r.repo, { commandLine: true });
      if (r.ref) assertSafeRef(r.ref);
      usable.push(r);
    } catch (e) {
      log.err(`${printable(r.type)} '${printable(r.name)}' (${printable(r.target)}): ${e.message}`);
      counts.failed++;
    }
  }
  if (usable.length === 0) {
    printSummary(counts);
    process.exit(1);
  }
  await assertGitAvailable();

  // Group by (repoKey + effective ref) so each repo is cloned once.
  const groups = new Map();
  for (const r of usable) {
    const useRef = refOverride !== null ? refOverride : (r.ref || null);
    const key = `${r.repoKey}\x00${useRef || ''}`;
    if (!groups.has(key)) groups.set(key, { repo: r.repo, ref: useRef, records: [] });
    groups.get(key).records.push(r);
  }

  const table = dryRun ? null : createTargetTable(
    [...new Set(toUpdate.map(r => r.target))],
    [...new Set(toUpdate.map(r => r.name))],
  );
  if (table) table.header();

  for (const group of groups.values()) {
    try {
      await withTempClone(group.repo, group.ref, async (cloneDir) => {
        const available = await scanClone(cloneDir);
        const find = record => available.find(i => i.type === record.type && safeOrNull(i.name) === record.name);

        // Replacing a hook or MCP server needs the same approval as installing one.
        let blocked = [];
        if (!dryRun) {
          const pairs = group.records.map(r => ({ item: find(r), target: r.target })).filter(p => p.item);
          const exec = await execToApprove(pairs, { manifest, force, config }, execCommands);
          if (!(await approveExec(exec, { allowExec: args.allowExec }, io))) {
            blocked = exec;
            skippedExec.push(...exec);
            execRefused = execRefused || !isInteractive(io, {});
          }
        }

        for (const record of group.records) {
          const item = find(record);
          if (item && blocked.some(b => b.item === item && b.target === record.target)) {
            if (table) table.row(record.target, record.name, log.TAG.mod(), P.execSkippedNote);
            counts.skipped++;
            continue;
          }
          if (!item) {
            if (table) table.row(record.target, record.name, log.TAG.fail(), `not found in ${group.repo}`);
            else log.err(`Failed to update ${record.type} '${record.name}': not found in ${group.repo}`);
            counts.failed++;
            continue;
          }
          try {
            const { result, tagName, note } = await installOne(item, {
              repo: group.repo,
              target: record.target,
              manifest,
              force,
              ref: group.ref,
              dryRun,
              config,
            });
            countResult(counts, result);
            if (table && tagName) {
              const projectScoped = targetScope(record.target) === 'project';
              const size = await largeSize(item);
              const trailing = [note, size ? P.largeNote(size) : null].filter(Boolean).join('; ') || (projectScoped ? '(project-scoped)' : null);
              table.row(record.target, record.name, log.TAG[tagName](), trailing);
            }
          } catch (e) {
            if (table) table.row(record.target, record.name, log.TAG.fail(), e.message);
            else log.err(`Failed to update ${record.type} '${printable(record.name)}': ${printable(e.message)}`);
            counts.failed++;
          }
        }
      });
    } catch (e) {
      log.err(printable(e.message));
      counts.failed += group.records.length;
    }
  }

  if (!dryRun) await writeManifest(manifest);

  if (dryRun) { log.dim(M.dry.previewDone); return; }

  printSummary(counts);
  if (skippedExec.length > 0) {
    const list = describeSkippedExec(skippedExec);
    log.info(execRefused ? P.execSkippedNoFlag(list) : P.execSkippedDeclined(list));
  }
  if (counts.failed > 0 || execRefused) process.exit(1);
}

function safeOrNull(name) {
  try { return sanitizeName(name); } catch { return null; }
}
