import { join } from 'node:path';
import readline from 'node:readline';
import { resolveDestination, expandTargets, ALL_TARGET } from '../targets.js';
import { sanitizeName, assertPathInside } from '../sanitize.js';
import { removePath } from '../fsops.js';
import { readManifest, writeManifest, getRecord, deleteRecord, allRecords } from '../manifest.js';
import { log } from '../log.js';
import * as M from '../messages.js';

export async function uninstallCommand(args) {
  const { skills, agents, all, target, force, dryRun } = args;

  const manifest = await readManifest();

  // Build the list of requested removals.
  const concreteTargets = expandTargets(target);
  const requested = all
    ? allRecords(manifest)
        .filter(r => !target || target === ALL_TARGET || r.target === target)
        .map(r => ({ type: r.type, name: r.name, target: r.target }))
    : [
        ...skills.flatMap(name => {
          try { return concreteTargets.map(t => ({ type: 'skill', name: sanitizeName(name), target: t })); }
          catch { log.err(`Invalid name: '${name}'`); return []; }
        }),
        ...agents.flatMap(name => {
          try { return concreteTargets.map(t => ({ type: 'agent', name: sanitizeName(name), target: t })); }
          catch { log.err(`Invalid name: '${name}'`); return []; }
        }),
      ];

  // Split into actually-present-in-manifest vs not-installed.
  const real = [];
  const phantoms = [];
  for (const req of requested) {
    if (getRecord(manifest, req.type, req.name, req.target)) real.push(req);
    else phantoms.push(req);
  }

  for (const p of phantoms) log.info(M.notInstalled(p.name));

  if (real.length === 0) {
    log.info(M.uninstallSummary(0, phantoms.length, 0));
    return;
  }

  if (dryRun) {
    for (const req of real) {
      log.info(M.dry.wouldRemove(req.type, req.name, destPathFor(req)));
    }
    log.dim(M.dry.previewDone);
    return;
  }

  if (!force) {
    if (!process.stdin.isTTY) {
      log.err(M.removeRefuseNoTTY);
      process.exit(1);
      return;
    }
    log.info(M.aboutToRemoveHeader(real.length));
    for (const req of real) log.info(M.aboutToRemoveLine(req.type, req.name, req.target));
    const answer = await prompt(M.removePrompt(real.length));
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      log.info(M.removeAborted);
      return;
    }
  }

  let removed = 0;
  let failures = 0;

  for (const req of real) {
    try {
      const destPath = destPathFor(req);
      assertPathInside(resolveDestination(req.target, req.type).base, destPath);
      try {
        await removePath(destPath);
      } catch (e) {
        if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(M.err.permission(destPath));
        throw e;
      }
      deleteRecord(manifest, req.type, req.name, req.target);
      log.ok(M.removed(req.type, req.name, req.target));
      removed++;
    } catch (e) {
      log.err(`Failed to uninstall ${req.type} '${req.name}': ${e.message}`);
      failures++;
    }
  }

  await writeManifest(manifest);

  log.info(M.uninstallSummary(removed, phantoms.length, failures));
  if (failures > 0) process.exit(1);
}

function destPathFor(req) {
  const { kind, base, ext } = resolveDestination(req.target, req.type);
  return kind === 'dir' ? join(base, req.name) : join(base, req.name + ext);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}
