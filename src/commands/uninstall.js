import readline from 'node:readline';
import { expandTargets } from '../install/targets.js';
import { TYPES } from '../repo/scan.js';
import { sanitizeName } from '../util/sanitize.js';
import { readManifest, writeManifest, getRecord, deleteRecord, recordsFor } from '../install/install-record.js';
import { locate, remove } from '../install/store.js';
import { log } from '../util/log.js';
import { createTargetTable } from '../util/table.js';
import * as M from '../util/messages.js';

export async function uninstallCommand(args) {
  const { names, all, targets, force, dryRun } = args;

  const manifest = await readManifest();
  const records = recordsFor(manifest, '');   // global installs only

  // No --target means "wherever it is installed".
  const concreteTargets = expandTargets(targets);
  const targetFilter = r => concreteTargets.length === 0 || concreteTargets.includes(r.target);

  // Split the request into records that exist and names that are not installed.
  const real = [];
  const phantoms = [];
  if (all) {
    real.push(...records.filter(targetFilter).map(r => ({ type: r.type, name: r.name, target: r.target })));
  } else {
    for (const type of TYPES) {
      for (const raw of names[type] || []) {
        let name;
        try { name = sanitizeName(raw); } catch { log.err(`Invalid name: '${raw}'`); continue; }
        const matches = records.filter(r => r.type === type && r.name === name && targetFilter(r));
        if (matches.length === 0) phantoms.push({ type, name });
        else real.push(...matches.map(r => ({ type, name, target: r.target })));
      }
    }
  }

  for (const p of phantoms) log.info(M.notInstalled(p.name));

  if (real.length === 0) {
    log.info(M.uninstallSummary(0, phantoms.length, 0));
    return;
  }

  if (dryRun) {
    for (const req of real) {
      log.info(M.dry.wouldRemove(req.type, req.name, displayFor(req)));
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

  const table = createTargetTable(real.map(r => r.target), real.map(r => r.name));
  table.header();

  for (const req of real) {
    try {
      const record = getRecord(manifest, req.type, req.name, req.target);
      const loc = locate(req.target, req.type, req.name);
      try {
        await remove(loc, record);
      } catch (e) {
        if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(M.err.permission(loc.destPath));
        throw e;
      }
      deleteRecord(manifest, req.type, req.name, req.target);
      table.row(req.target, req.name, log.TAG.ok(), 'removed');
      removed++;
    } catch (e) {
      table.row(req.target, req.name, log.TAG.fail(), e.message);
      failures++;
    }
  }

  await writeManifest(manifest);

  log.info(M.uninstallSummary(removed, phantoms.length, failures));
  if (failures > 0) process.exit(1);
}

function displayFor(req) {
  try { return locate(req.target, req.type, req.name).display; }
  catch { return `${req.target}:${req.name}`; }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}
