// All user-facing strings and status glyphs live here.

import { log } from './log.js';

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
export const updatedShort = (type, name)      => `${log.TAG.upd()} Updated ${type} '${name}'`;

export const locallyModified = (name, target) => [
  `${GLYPH.warn} ${name} (${target}) has local changes that would be lost.`,
  `  Re-run with --force to overwrite.`,
];

export const notFoundInRepo = (type, name, repo, available) => [
  `${GLYPH.missing} ${type} '${name}' not found in ${repo}.`,
  `  Available ${type}s: ${available.length ? available.join(', ') : '(none)'}.`,
];

export const notInstalledForUpdate = (name) =>
  `${GLYPH.missing} ${name} is not installed; use 'morf install' to add it.`;

// ── uninstall (per item) ─────────────────────────────────────────────────────
export const removed      = (type, name, target) => `Removed ${type} '${name}' (${target})`;
export const notInstalled = (name)               => `${name} is not installed (skipping).`;

export const aboutToRemoveHeader = (n) => `About to remove ${n} item(s):`;
export const aboutToRemoveLine   = (type, name, target) => `  - ${type} '${name}' (${target})`;
export const removePrompt        = (n) => `Remove ${n} item(s)? [y/N] `;
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
    parts.push(suffix ? `${label} ${n} ${suffix}` : `${label} ${n}`);
  }
  if (parts.length === 0) return null;
  parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
  return parts.join(', ') + '.';
}

export const installSkippedHint = `  Re-run with --force to overwrite skipped items.`;

export const uninstallSummary = (removed_, skipped, failed) =>
  `Removed ${removed_}, skipped ${skipped}, failed ${failed}.`;

// ── list ─────────────────────────────────────────────────────────────────────
export const listEmpty           = `No skills or agents managed by morf yet.`;
export const listManagedHeader   = `managed by morf:`;
export const listUnmanagedHeader = `found on disk, not managed by morf:`;
export const listUnmanagedNone   = `  (none)`;
export const listCheckingHeader  = `Checking repos for updates...`;

export const LIST_STATUS = {
  upToDate:        `${GLYPH.ok} up to date`,
  updateAvailable: `${GLYPH.updated} update available`,
  locallyModified: `${GLYPH.modified} locally modified`,
  missingFromDisk: `${GLYPH.missing} missing from disk`,
};

// ── dry-run ──────────────────────────────────────────────────────────────────
export const dry = {
  wouldInstall:   (type, name, dest) => `${DRY_RUN_PREFIX} would install ${type} '${name}' -> ${dest}`,
  wouldUpdate:    (type, name, dest) => `${DRY_RUN_PREFIX} would update ${type} '${name}' -> ${dest}`,
  wouldSkip:      (name)             => `${DRY_RUN_PREFIX} would skip '${name}' (locally modified; needs --force)`,
  alreadyCurrent: (name)             => `${DRY_RUN_PREFIX} '${name}' is already up to date`,
  wouldRemove:    (type, name, dest) => `${DRY_RUN_PREFIX} would remove ${type} '${name}' <- ${dest}`,
  previewDone:                          `${DRY_RUN_PREFIX} Preview complete. Nothing was written.`,
};

// ── errors (friendly; no stack traces; all exit nonzero) ─────────────────────
export const err = {
  gitMissing:            `git is required but was not found. Please install git and try again.`,
  repoNotFound:    (r) => `Repository not found or you don't have access: ${r}`,
  network:               `Couldn't reach the git server. Check your network/VPN and the URL.`,
  authFailed:      (r) => `Authentication failed for ${r}. Check your git credentials / SSH key / access.`,
  badRef:    (ref, r) => `Branch or tag '${ref}' not found in ${r}.`,
  permission:      (p) => `Permission denied writing to ${p}. Check your permissions.`,
  emptyRepo:       (r) => `No skills or agents found in ${r}.`,
  unknownAlias: (a, known) => `Unknown alias '${a}'. Known aliases: ${known.length ? known.join(', ') : '(none)'}.`,
  noRepo:                `No repo given and no defaultRepo configured. ` +
                         `Provide a repo or set one with 'morf config repo <url>'.`,
  allWithNamed:          `--all cannot be combined with --skill/--agent.`,
};
