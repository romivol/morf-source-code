import { assertGitAvailable, withTempClone } from '../git.js';
import { scanRepo } from '../scan.js';
import { sanitizeName } from '../sanitize.js';
import { ALL_TARGET } from '../targets.js';
import { readManifest, writeManifest, allRecords } from '../manifest.js';
import { readConfig } from '../config.js';
import { log } from '../log.js';
import { installOne, countResult, printSummary } from './install.js';
import * as M from '../messages.js';

export async function updateCommand(args) {
  const { skills, agents, all, target, force, ref: refOverride, dryRun } = args;

  await assertGitAvailable();
  const config = await readConfig();

  const manifest = await readManifest();
  const records = allRecords(manifest);

  const counts = { installed: 0, updated: 0, upToDate: 0, skipped: 0, failed: 0 };

  let toUpdate = [];
  const unknown = [];

  const targetFilter = r => !target || target === ALL_TARGET || r.target === target;

  if (all) {
    toUpdate = records.filter(targetFilter);
  } else {
    const wanted = [
      ...skills.map(n => ({ type: 'skill', orig: n, name: safeOrNull(n) })),
      ...agents.map(n => ({ type: 'agent', orig: n, name: safeOrNull(n) })),
    ];
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

  // Group by (repoKey + effective ref) so each repo is cloned once.
  const groups = new Map();
  for (const r of toUpdate) {
    const useRef = refOverride !== null ? refOverride : (r.ref || null);
    const key = `${r.repoKey}\x00${useRef || ''}`;
    if (!groups.has(key)) groups.set(key, { repo: r.repo, ref: useRef, records: [] });
    groups.get(key).records.push(r);
  }

  const total = toUpdate.length;
  let done = 0;

  for (const group of groups.values()) {
    try {
      await withTempClone(group.repo, group.ref, async (cloneDir) => {
        const available = await scanRepo(cloneDir);
        for (const record of group.records) {
          const item = available.find(i =>
            i.type === record.type && sanitizeName(i.name) === record.name
          );
          done++;
          const prefix = total > 1 ? log.meta(`[${done}/${total}] `) : '';
          if (!item) {
            log.err(`${prefix}Failed to update ${record.type} '${record.name}': not found in ${group.repo}`);
            counts.failed++;
            continue;
          }
          try {
            const result = await installOne(item, {
              repo: group.repo,
              target: record.target,
              manifest,
              force,
              ref: group.ref,
              dryRun,
              config,
              prefix,
            });
            countResult(counts, result);
          } catch (e) {
            log.err(`${prefix}Failed to update ${record.type} '${record.name}': ${e.message}`);
            counts.failed++;
          }
        }
      });
    } catch (e) {
      log.err(e.message);
      for (const _ of group.records) counts.failed++;
    }
  }

  if (!dryRun) await writeManifest(manifest);

  if (dryRun) { log.dim(M.dry.previewDone); return; }

  printSummary(counts);
  if (counts.failed > 0) process.exit(1);
}

function safeOrNull(name) {
  try { return sanitizeName(name); } catch { return null; }
}
