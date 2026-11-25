// The plan and the approval gate for project mode.
//
// Nothing is installed, replaced or removed in a project without explicit
// approval. Every project-mode command builds a list of actions, prints it as a
// plan, and passes it through `approve` before touching the disk.
//
//   Interactive terminal   asks "Apply these changes?" (default No); if the
//                          plan has hooks or MCP servers, asks a second,
//                          separate question for those (default No).
//   CI / --frozen / no TTY never asks. Needs --yes; hooks and MCP servers also
//                          need --allow-exec.
//
// --yes and --allow-exec come only from the command line of this one run. They
// are never read from a config file, the project file, the lockfile or the
// environment — this module only ever sees the parsed flags.

import readline from 'node:readline';
import { listTargets } from '../install/targets.js';
import { log } from '../util/log.js';
import { project as P } from '../util/messages.js';

// Actions that change something on disk.
const CHANGES = new Set(['install', 'replace', 'overwrite', 'remove']);
const EXEC_TYPES = new Set(['hook', 'mcp']);

// The commands an item would run, for the "runs commands" list.
export function execCommands(item) {
  const p = item.payload;
  if (!p || typeof p !== 'object') return [];
  if (item.type === 'mcp') {
    if (typeof p.url === 'string' && p.command === undefined) return [p.url];
    const cmd = Array.isArray(p.command) ? p.command : [p.command];
    return [[...cmd, ...(Array.isArray(p.args) ? p.args : [])].join(' ')];
  }
  const out = [];
  for (const groups of Object.values(p)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const handlers = g && Array.isArray(g.hooks) ? g.hooks : (g && g.command ? [g] : []);
      for (const h of handlers) if (h && typeof h.command === 'string') out.push(h.command);
    }
  }
  return [...new Set(out)];
}

export function isInteractive(io, flags) {
  return Boolean(io.isTTY) && !io.env.CI && !flags.frozen;
}

// The real terminal. Tests pass their own io object instead.
export function defaultIo() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    env: process.env,
    ask(question) {
      return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => { rl.close(); resolve(answer); });
      });
    },
  };
}

const yes = answer => ['y', 'yes'].includes(String(answer).trim().toLowerCase());

function shortCommit(commit) {
  if (!commit) return '';
  return (process.stdout.columns || 80) >= 140 ? commit : commit.slice(0, 7);
}

// Print every action, grouped by tool.
export function printPlan(root, actions, warnings = []) {
  log.info(`Project: ${root}`);
  log.info('');
  const shown = actions.filter(a => a.op !== 'current');
  if (shown.length === 0) {
    log.info(P.nothingToDo);
  } else {
    log.bold(P.planHeader);
    const nameW = Math.max(...shown.map(a => a.name.length));
    for (const target of listTargets()) {
      const mine = shown.filter(a => a.target === target);
      if (mine.length === 0) continue;
      log.info(`  ${target}`);
      for (const a of mine) {
        const where = a.repo ? `${a.repo}${a.commit ? ` @ ${shortCommit(a.commit)}` : ''}` : '';
        const detail = a.reason ? (where && CHANGES.has(a.op) ? `${where}  (${a.reason})` : a.reason) : where;
        log.info(`    ${a.op.padEnd(12)}${a.type.padEnd(8)}${a.name.padEnd(nameW + 3)}${detail}`.replace(/\s+$/, ''));
      }
    }
    log.info('');
    const n = op => shown.filter(a => a.op === op).length;
    const parts = [
      [n('install'), 'to install'], [n('replace') + n('overwrite'), 'to replace'], [n('remove'), 'to remove'],
      [n('skip'), 'skipped'], [n('unsupported'), 'unsupported'], [n('prune'), 'to prune'],
    ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
    log.info(parts.join(', ') + '.');
  }
  for (const w of warnings) log.warn(w);
}

function printExec(execActions) {
  log.info('');
  log.info(P.execHeader);
  const byItem = new Map();
  for (const a of execActions) {
    const key = `${a.type}:${a.name}`;
    const cur = byItem.get(key) || { type: a.type, name: a.name, targets: [], commands: a.exec || [] };
    cur.targets.push(a.target);
    byItem.set(key, cur);
  }
  const nameW = Math.max(...[...byItem.values()].map(i => i.name.length));
  for (const i of byItem.values()) {
    log.info(`  ${i.type.padEnd(6)}${i.name.padEnd(nameW + 3)}${i.targets.join(', ')}`);
    for (const c of i.commands) log.info(`        ${c}`);
  }
  log.info('');
}

// Decide whether the plan may be applied.
// Returns { apply, prune } — `apply` false means: change nothing, exit 1.
//   flags: { yes, allowExec, prune, frozen }   io: { isTTY, env, ask }
export async function approve(actions, flags, io) {
  const changes = actions.filter(a => CHANGES.has(a.op));
  const prunes = actions.filter(a => a.op === 'prune');
  // Only installing or replacing a hook or MCP server puts code in a position
  // to run. Removing one runs nothing, so it never needs --allow-exec.
  const exec = changes.filter(a => a.op !== 'remove' && EXEC_TYPES.has(a.type));

  if (changes.length === 0 && prunes.length === 0) return { apply: true, prune: false };

  if (!isInteractive(io, flags)) {
    const wantPrune = prunes.length > 0 && Boolean(flags.prune);
    if (changes.length === 0 && !wantPrune) return { apply: true, prune: false };
    if (!flags.yes) {
      log.info(P.needYes);
      return { apply: false, prune: false };
    }
    if (exec.length > 0 && !flags.allowExec) {
      printExec(exec);
      log.info(P.needAllowExec);
      return { apply: false, prune: false };
    }
    return { apply: true, prune: wantPrune };
  }

  if (changes.length > 0) {
    if (!flags.yes && !yes(await io.ask(P.askApply))) {
      log.info(P.cancelled);
      return { apply: false, prune: false };
    }
    if (exec.length > 0) {
      printExec(exec);
      if (!flags.allowExec && !yes(await io.ask(P.askExec))) {
        log.info(P.cancelled);
        return { apply: false, prune: false };
      }
    }
  }

  let prune = false;
  if (prunes.length > 0) {
    prune = Boolean(flags.prune) || yes(await io.ask(P.askPrune(prunes.length)));
  }
  return { apply: true, prune };
}
