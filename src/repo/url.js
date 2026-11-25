// Repo-URL handling: canonical keys, shorthand expansion, and cleaning a URL
// for the committed project files.

import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { assertSafeRepo, redact } from './validate.js';

// Canonical repo-key computation for "is this the same repo?" comparisons.
// Conservative: only normalizes format differences, never merges different hosts.
export function normalizeRepo(input) {
  let s = input.trim();

  // Local absolute paths (Unix /… or Windows C:\…) are not git remote URLs;
  // return them as-is so they compare equal to themselves.
  if (s.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(s)) {
    return s;
  }

  // SCP-style SSH (no :// present and a colon appears before any slash):
  // [user@]host:path  →  host/path
  if (!s.includes('://')) {
    const scpMatch = s.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (scpMatch) {
      const host = scpMatch[1].toLowerCase();
      const path = scpMatch[2].replace(/\.git$/, '').replace(/\/$/, '');
      return `${host}/${path}`;
    }
    // host/path shorthand — strip any accidental user@ prefix.
    s = s.replace(/^[^@/]+@/, '');
  } else {
    // Strip scheme (ssh://, https://, http://, git://).
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    // Strip userinfo (user@ or user:password@).
    s = s.replace(/^[^@]+@/, '');
    // Strip :port from host (digits only, not part of path).
    s = s.replace(/^([^/:]+):\d+(?=\/|$)/, '$1');
  }

  // Lowercase host only; preserve path case.
  const slashIdx = s.indexOf('/');
  if (slashIdx !== -1) {
    const host = s.slice(0, slashIdx).toLowerCase();
    const path = s.slice(slashIdx + 1).replace(/\.git$/, '').replace(/\/$/, '');
    return `${host}/${path}`;
  }
  return s.toLowerCase().replace(/\.git$/, '');
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// host.tld/owner/repo[/more] — nothing else.
const SHORTHAND = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/[\w.-]+\/[\w.-]+(\/[\w.-]+)*$/i;

// `github.com/acme/agents` is not something git can clone: it reads it as a
// local path. Expand it to https://… — but only when it clearly has the
// host/owner/repo shape and no local directory of that name exists.
export function expandRepoShorthand(repo, cwd = process.cwd()) {
  const s = String(repo).trim();
  if (HAS_SCHEME.test(s) || s.includes('@') || s.includes(':') || s.includes('\\')) return repo;
  if (/^[./~]/.test(s)) return repo;
  if (!SHORTHAND.test(s)) return repo;
  if (existsSync(resolve(cwd, s))) return repo;
  return `https://${s}`;
}

// SCP-style remote: [user@]host:path (and not a Windows drive path).
function isScpStyle(s) {
  return !HAS_SCHEME.test(s) && !/^[a-zA-Z]:[/\\]/.test(s) && /^(?:[^@/\s]+@)?[^/:\s]+:[^\s]+$/.test(s);
}

// Prepare a repo argument for the committed project files.
// Returns { stored, cloneUrl, local }:
//   stored    what goes into morf.json / morf.lock.json — no credentials, no
//             absolute path
//   cloneUrl  what git is given on this machine
// Throws when the URL cannot be cleaned safely or a local path cannot be made
// relative to the project root.
export function cleanRepoForProject(repo, root, cwd = process.cwd()) {
  assertSafeRepo(repo, { commandLine: true });
  const expanded = expandRepoShorthand(repo, cwd).trim();

  if (HAS_SCHEME.test(expanded)) {
    let url;
    try { url = new URL(expanded); } catch { throw new Error(`Not a valid repository URL: ${redact(expanded)}`); }
    if (url.search || url.hash) {
      throw new Error(
        `The repository URL has a query string or fragment, which may hold a token, so morf cannot store it safely: ` +
        `${redact(expanded)}. Use a URL without it (set credentials in git instead).`
      );
    }
    const web = url.protocol === 'http:' || url.protocol === 'https:';
    // http(s): any userinfo is a credential. ssh/git: the user name is part of
    // the address, a password never is.
    const user = web ? '' : url.username;
    const stored = `${url.protocol}//${user ? user + '@' : ''}${url.host}${url.pathname}`.replace(/\/$/, '');
    return { stored, cloneUrl: expanded, local: false };
  }

  if (isScpStyle(expanded)) {
    const at = expanded.lastIndexOf('@');
    if (at !== -1 && expanded.slice(0, at).includes(':')) {
      throw new Error(`The repository URL contains a password, so morf cannot store it safely: ${redact(expanded)}`);
    }
    return { stored: expanded, cloneUrl: expanded, local: false };
  }

  // Local path: stored relative to the project root, with forward slashes.
  const abs = resolve(cwd, expanded);
  const rel = relative(root, abs);
  if (isAbsolute(rel)) {
    throw new Error(
      `The local repository ${abs} cannot be written relative to the project root ${root} ` +
      `(different drive). Move it, or use a remote URL.`
    );
  }
  let stored = rel.replace(/\\/g, '/') || '.';
  if (!stored.startsWith('.')) stored = `./${stored}`;
  return { stored, cloneUrl: abs, local: true };
}

// Turn a stored repo back into something git can clone on this machine.
export function resolveStoredRepo(stored, root) {
  return stored.startsWith('.') ? resolve(root, stored) : stored;
}

// True when two repo values name the same repository: the same remote under
// any spelling (https, ssh, scp-style, host/owner/repo, with or without .git),
// or the same local directory. `base` is what a relative local path is
// relative to.
export function sameRepo(a, b, base = process.cwd()) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const local = r => !HAS_SCHEME.test(r) && !isScpStyle(r) && (/^[./~]/.test(r) || /^[a-zA-Z]:[\\/]/.test(r) || r.startsWith('/') || existsSync(resolve(base, r)));
  if (local(a) || local(b)) {
    if (!(local(a) && local(b))) return false;
    const norm = r => {
      const p = resolve(base, r).split('\\').join('/').replace(/\/+$/, '');
      return process.platform === 'win32' ? p.toLowerCase() : p;
    };
    return norm(a) === norm(b);
  }
  return normalizeRepo(a) === normalizeRepo(b);
}
