// Building and applying a plan in project mode: helpers shared by the
// project commands (sync, update, install, uninstall).

import { READS_ROOT_AGENTS_MD } from '../install/targets.js';
import { portableHashPath } from '../util/fs.js';
import { hashValue } from '../install/json-file.js';
import { commit, removeInstalled, safeOrName } from '../install/engine.js';
import { execCommands } from './approve.js';
import { log } from '../util/log.js';
import { createTargetTable } from '../util/table.js';
import { project as P } from '../util/messages.js';

// The lockfile hash of a source item: portable across machines.
export async function lockHashOf(item) {
  if (item.payload !== undefined) return 'sha256:' + hashValue(item.payload);
  return portableHashPath(item.srcPath);
}

export const tripleKey = (type, name, target) => `${type}:${name}:${target}`;

export function findItem(available, type, name) {
  return available.find(i => i.type === type && safeOrName(i.name) === safeOrName(name)) || null;
}

// Turn a prepared item into a plan action.
export function toAction(prep, { item, target, repo, commit: sha, force }) {
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
export async function applyActions(actions, { manifest, scope, refOf }) {
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

export async function applyPrunes(prunes, manifest) {
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
export function doubleRuleWarnings(desired) {
  const out = [];
  for (const d of desired) {
    if (d.type !== 'rule' || !d.targets.includes('codex')) continue;
    const also = d.targets.filter(t => READS_ROOT_AGENTS_MD.includes(t));
    if (also.length) out.push(P.doubleRule(d.name, also));
  }
  return out;
}

export async function closeAll(clones) {
  await Promise.all([...clones.values()].map(c => c.close()));
}
