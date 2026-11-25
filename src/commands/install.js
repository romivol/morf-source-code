// morf install (global mode).

import { assertGitAvailable, withTempClone } from '../repo/git.js';
import { scanRepo } from '../repo/scan.js';
import { expandTargets, targetScope } from '../install/targets.js';
import { readManifest, writeManifest } from '../install/install-record.js';
import { readConfig, resolveRepo } from '../util/config.js';
import { selectItems, safeOrName, installOne } from '../install/engine.js';
import { log, printable } from '../util/log.js';
import { assertSafeRef } from '../repo/validate.js';
import { createTargetTable } from '../util/table.js';
import * as M from '../util/messages.js';

const NOTE_INDENT = '         '; // 9 spaces

export async function installCommand(args) {
  const { repoArg, names, all, targets, force, ref, dryRun } = args;

  const config = await readConfig();
  // Both are validated before git is started (resolveRepo checks the repo).
  const repo = resolveRepo(repoArg, config);
  if (ref) assertSafeRef(ref);

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
      log.miss(printable(m.name));
      log.dim(`${NOTE_INDENT}error: ${m.type} '${printable(m.name)}' not found in repo; available: ${m.available.length ? printable(m.available.join(', ')) : '(none)'}`);
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
          else { log.err(`${printable(item.name)} (${concreteTarget})`); log.dim(`${NOTE_INDENT}error: ${printable(e.message)}`); }
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
