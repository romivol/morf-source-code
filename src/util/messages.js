// All user-facing strings and status glyphs live here.

import { log, printable } from './log.js';

// Tag for message templates: every interpolated value is escaped with
// `printable`, so a repo, ref, name or path taken from a file or a source
// repository can never put control characters on the terminal.
function t(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += printable(values[i]) + strings[i + 1];
  return out;
}

// ── glyphs (ASCII only — renders everywhere including legacy cmd) ─────────────
export const GLYPH = {
  ok:       '[OK]',
  updated:  '[UPD]',
  modified: '[MOD]',
  missing:  '[MISS]',
  warn:     '[!]',
  bullet:   '-',
};

export const DRY_RUN_PREFIX = '[dry-run]';

// ── install / update (per item) ──────────────────────────────────────────────
export const installed   = (type, name, dest) => `${log.TAG.ok()} Installed ${type} '${name}' -> ${dest}`;
export const updated     = (type, name, dest) => `${log.TAG.upd()} Updated ${type} '${name}' -> ${dest}`;
export const upToDate    = (name)             => `${log.TAG.ok()} ${name} is already up to date`;

export const notInstalledForUpdate = (name) =>
  t`${GLYPH.missing} ${name} is not installed; use 'morf install' to add it.`;

// ── uninstall (per item) ─────────────────────────────────────────────────────
export const removed      = (type, name, target) => t`Removed ${type} '${name}' (${target})`;
export const notInstalled = (name)               => t`${name} is not installed (skipping).`;

export const aboutToRemoveHeader = (n) => t`About to remove ${n} item(s):`;
export const aboutToRemoveLine   = (type, name, target) => t`  - ${type} '${name}' (${target})`;
export const removePrompt        = (n) => t`Remove ${n} item(s)? [y/N] `;
export const removeAborted       = `Aborted. Nothing was removed.`;
export const removeRefuseNoTTY   =
  `Refusing to delete without confirmation. ` +
  `Re-run with --force (or -y) in a non-interactive shell.`;

// ── summary lines ────────────────────────────────────────────────────────────
const INSTALL_PARTS = [
  ['installed',  'installed'],
  ['updated',    'updated'],
  ['upToDate',   'up-to-date'],
  ['skipped',    'skipped',   '(locally modified)'],
  ['failed',     'failed'],
];

export function installSummary(counts) {
  const parts = [];
  for (const [key, label, suffix] of INSTALL_PARTS) {
    const n = counts[key] || 0;
    if (!n) continue;
    parts.push(suffix ? t`${label} ${n} ${suffix}` : t`${label} ${n}`);
  }
  if (parts.length === 0) return null;
  parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
  return parts.join(', ') + '.';
}

export const installSkippedHint = `  Re-run with --force to overwrite skipped items.`;

export const uninstallSummary = (removed_, skipped, failed) =>
  t`Removed ${removed_}, skipped ${skipped}, failed ${failed}.`;

// ── list ─────────────────────────────────────────────────────────────────────
export const listEmpty           = `Nothing managed by morf yet.`;
export const listCheckingHeader  = `Checking repos for updates...`;

// ── dry-run ──────────────────────────────────────────────────────────────────
export const dry = {
  wouldInstall:   (type, name, dest) => t`${DRY_RUN_PREFIX} would install ${type} '${name}' -> ${dest}`,
  wouldUpdate:    (type, name, dest) => t`${DRY_RUN_PREFIX} would update ${type} '${name}' -> ${dest}`,
  wouldSkip:      (name)             => t`${DRY_RUN_PREFIX} would skip '${name}' (locally modified; needs --force)`,
  wouldSkipUnsupported: (name, target) => t`${DRY_RUN_PREFIX} would skip '${name}' (not supported by ${target})`,
  alreadyCurrent: (name)             => t`${DRY_RUN_PREFIX} '${name}' is already up to date`,
  wouldRemove:    (type, name, dest) => t`${DRY_RUN_PREFIX} would remove ${type} '${name}' <- ${dest}`,
  previewDone:                          t`${DRY_RUN_PREFIX} Preview complete. Nothing was written.`,
};

// ── errors (friendly; no stack traces; all exit nonzero) ─────────────────────
export const err = {
  gitMissing:            `git is required but was not found. Please install git and try again.`,
  repoNotFound:    (r) => t`Repository not found or you don't have access: ${r}`,
  network:               `Couldn't reach the git server. Check your network/VPN and the URL.`,
  authFailed:      (r) => t`Authentication failed for ${r}. Check your git credentials / SSH key / access.`,
  badRef:    (ref, r) => t`Branch or tag '${ref}' not found in ${r}.`,
  permission:      (p) => t`Permission denied writing to ${p}. Check your permissions.`,
  emptyRepo:       (r) => t`No skills, agents, rules, prompts, hooks or MCP servers found in ${r}.`,
  unknownAlias: (a, known) => t`Unknown alias '${a}'. Known aliases: ${known.length ? known.join(', ') : '(none)'}.`,
  noRepo:                `No repo given and no defaultRepo configured. ` +
                         `Provide a repo or set one with 'morf config repo <url>'.`,
  allWithNamed:          `--all cannot be combined with --skill/--agent/--rule/--prompt/--hook/--mcp.`,
  checkoutFailed: (path, why, r) => path
    ? t`git could not check out "${path}" from ${r} on this system (${why}). Nothing from that repository was installed.`
    : t`git could not check out ${r} on this system (${why}). Nothing from that repository was installed.`,
  commitUnavailable: (c, r) => t`Commit ${c} could not be fetched from ${r}. Nothing from that source was installed.`,
};

// ── project mode (project file, lockfile, sync) ──────────────────────────────
export const project = {
  initDone:        (p) => t`Created ${p}. Add items with: morf install <repo>`,
  initExists:      (p) => t`A project file already exists at ${p}.`,
  noProject:             `No project file (morf.json) found here or in any parent directory. ` +
                         `Run 'morf init' to create one.`,
  lockTooNew:   (v, max) => t`The lockfile is version ${v}, but this morf understands up to version ${max}. ` +
                         `Upgrade morf (npm install -g @romivol/morf) and try again.`,
  badProjectFile: (p, why) => t`The project file ${p} is not valid (${why}). Fix it and try again.`,
  badLockfile:  (p, why) => t`The lockfile ${p} is not valid (${why}). Fix it, or delete it and run 'morf sync'.`,
  localSource:     (r) => t`'${r}' is a local path. It is stored relative to the project and will not resolve on other machines.`,
  frozenNoLock:          `--frozen: there is no lockfile. Run 'morf sync' without --frozen to create it.`,
  frozenDrift:           `--frozen: the project file and the lockfile do not match. Run 'morf sync' without --frozen.`,
  frozenEdited:          `--frozen: some items were edited locally. Re-run with --force to overwrite them.`,
  hashMismatch: (type, name, repo) =>
    t`The content of ${type} '${name}' from ${repo} does not match the lockfile. Nothing from that source was installed.`,
  notInPinned: (type, name, repo, commit) =>
    t`${type} '${name}' does not exist in ${repo} at the pinned commit ${commit.slice(0, 7)}. Run 'morf update' to move the pin.`,
  planHeader:            `Plan`,
  nothingToDo:           `Everything matches the lockfile. Nothing to do.`,
  askApply:              `Apply these changes? [y/N] `,
  execHeader:            `These items run commands on your machine:`,
  askExec:               `Install the hooks and MCP servers listed above? [y/N] `,
  askPrune:        (n) => t`Remove ${n} item${n === 1 ? '' : 's'} no longer in the lockfile? [y/N] `,
  cancelled:             `Cancelled. Nothing was changed.`,
  execNeedsFlag:         `Hooks and MCP servers were not installed: this is a non-interactive run. Re-run with --allow-exec to install them.`,
  execDeclined:          `Hooks and MCP servers were not installed.`,
  execSkippedNote:       `not approved (hooks and MCP servers run commands)`,
  dryRun:                `[dry-run] This is the plan only. Nothing was changed.`,
  needYes:               `Not applied: this is a non-interactive run. Re-run with --yes to apply.`,
  needAllowExec:         `Not applied: the plan contains hooks or MCP servers. Re-run with --yes --allow-exec to apply.`,
  pruneKept:       (n) => t`${n} item${n === 1 ? ' is' : 's are'} no longer in the lockfile and ${n === 1 ? 'was' : 'were'} left in place. Remove with --prune.`,
  skippedEdited:   (n) => t`${n} item${n === 1 ? ' was' : 's were'} skipped because of local edits (use --force to overwrite):`,
  driftDeclHeader:       `Drift: project file vs lockfile`,
  driftDiskHeader:       `Drift: lockfile vs what is on disk`,
  noDrift:               `No drift. The project matches the lockfile.`,
  largeItem: (type, name, size) => t`${type} '${name}' is ${size}. morf has no size limit; check that this is what you expect.`,
  largeNote: (size) => t`large: ${size}`,
  doubleRule: (name, tools) =>
    t`rule '${name}' is written to AGENTS.md for codex, and ${tools.join(', ')} also read${tools.length === 1 ? 's' : ''} AGENTS.md, ` +
    `so the rule will apply twice there.`,
};
