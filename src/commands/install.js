// morf install (global mode).

import { assertGitAvailable, withTempClone, scanClone } from '../repo/git.js';
import { expandTargets, targetScope } from '../install/targets.js';
import { readManifest, writeManifest } from '../install/install-record.js';
import { readConfig, resolveRepo } from '../util/config.js';
import { selectItems, safeOrName, installOne, execToApprove, largeSize } from '../install/engine.js';
import { approveExec, execCommands, defaultIo, isInteractive } from '../project/approve.js';
import { project as P } from '../util/messages.js';
import { log, printable } from '../util/log.js';
import { assertSafeRef } from '../repo/validate.js';
import { createTargetTable } from '../util/table.js';
import * as M from '../util/messages.js';

const NOTE_INDENT = '         '; // 9 spaces

export async function installCommand(args, io = defaultIo()) {
  const { repoArg, names, all, targets, force, ref, dryRun } = args;

  const config = await readConfig();
  // Both are validated before git is started (resolveRepo checks the repo).
  const repo = resolveRepo(repoArg, config);
  if (ref) assertSafeRef(ref);

  await assertGitAvailable();

  const counts = { installed: 0, updated: 0, upToDate: 0, skipped: 0, failed: 0 };
  const concreteTargets = expandTargets(targets);
  let execRefused = false;
  const skippedExec = [];

  await withTempClone(repo, ref, async (cloneDir) => {
    const available = await scanClone(cloneDir);

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

    // Hooks and MCP servers run commands, so they are never installed
    // silently: list them and get a yes (or --allow-exec) first. Everything
    // else installs as before whatever the answer.
    // Unusually large items are pointed out on their row.
    const large = new Map();
    for (const item of selected) {
      const size = await largeSize(item);
      if (size) large.set(item, P.largeNote(size));
    }

    let blocked = [];
    if (!dryRun) {
      const pairs = concreteTargets.flatMap(target => selected.map(item => ({ item, target })));
      const exec = await execToApprove(pairs, { manifest, force, config }, execCommands);
      if (!(await approveExec(exec, { allowExec: args.allowExec }, io))) {
        blocked = exec;
        skippedExec.push(...exec);
        execRefused = !isInteractive(io, {});
      }
    }

    const selectedNames = selected.map(i => safeOrName(i.name));
    const table = (!dryRun && selected.length > 0)
      ? createTargetTable(concreteTargets, selectedNames)
      : null;
    if (table) table.header();

    for (const concreteTarget of concreteTargets) {
      const projectScoped = targetScope(concreteTarget) === 'project';

      for (const item of selected) {
        const rowName = safeOrName(item.name);
        if (blocked.some(b => b.item === item && b.target === concreteTarget)) {
          if (table) table.row(concreteTarget, rowName, log.TAG.mod(), P.execSkippedNote);
          counts.skipped++;
          continue;
        }
        try {
          const { result, tagName, note } =
            await installOne(item, { repo, target: concreteTarget, manifest, force, ref, dryRun, config });
          countResult(counts, result);
          if (table && tagName) {
            const trailing = [note, large.get(item)].filter(Boolean).join('; ') || (projectScoped ? '(project-scoped)' : null);
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
  // Say plainly which hooks and MCP servers were left out, and why.
  if (skippedExec.length > 0) {
    const list = describeSkippedExec(skippedExec);
    log.info(execRefused ? P.execSkippedNoFlag(list) : P.execSkippedDeclined(list));
  }
  // A non-interactive run that could not install what it was asked to is a failure.
  if (counts.failed > 0 || execRefused) process.exit(1);
}

// "hook 'guard' (claude), mcp 'context7' (claude, codex)" for the summary line.
export function describeSkippedExec(blocked) {
  const byItem = new Map();
  for (const b of blocked) {
    const key = `${b.type} '${b.name}'`;
    byItem.set(key, [...(byItem.get(key) || []), b.target]);
  }
  return [...byItem.entries()].map(([item, targets]) => `${item} (${[...new Set(targets)].join(', ')})`).join(', ');
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
