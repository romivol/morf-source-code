// Validation of values that end up on a git command line or in a file path.
//
// A repo, a ref and an item name can come from places morf does not control:
// morf.json and morf.lock.json (written by someone else and pulled with the
// project), the command line, the config file and the install record. None of
// them may be handed to git until it has passed these checks, because git
// reads a value starting with "-" as an option and "x::y" as a remote helper
// to run.
//
// Each function throws an Error with a message fit to show the user.

import { sanitizeName } from '../util/sanitize.js';
import { printable } from '../util/log.js';

function hasControl(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || (c >= 127 && c <= 159)) return true;
  }
  return false;
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const DRIVE = /^[A-Za-z]:[\\/]/;
const SCP = /^([^@\s/:]+)@([^:\s/]+):(.+)$/;

const ALLOWED = 'Use an https:// or ssh:// URL, an address like user@host:path, or a relative path starting with ./ or ../';

// Hide credentials when a repository has to appear in a message: the user and
// password of a URL, the part before "@" of an address, and any query string.
export function redact(s) {
  return String(s)
    .replace(/\/\/[^/@]*@/, '//***@')
    .replace(/^[^@/\s]*:[^@/\s]*@/, '***@')
    .replace(/[?#].*$/, '?***');
}

function badRepo(repo, why, commandLine) {
  const shown = typeof repo === 'string' ? `"${printable(redact(repo))}"` : String(repo);
  return new Error(`The repository ${shown} is not valid: ${why}. ${ALLOWED}${commandLine ? ' (or any local path)' : ''}.`);
}

// A repository location. In the project files only four shapes are allowed:
// https://, ssh://, user@host:path, and a relative local path (./ or ../).
// On the command line (`commandLine: true`) an absolute local path, a bare
// relative path and the host/owner/repo shorthand are accepted too, since
// they are rewritten before anything is stored.
export function assertSafeRepo(repo, { commandLine = false } = {}) {
  const bad = why => badRepo(repo, why, commandLine);
  if (typeof repo !== 'string' || repo === '') throw bad('it is empty or not text');
  if (hasControl(repo)) throw bad('it contains control characters');
  if (repo.startsWith('-')) throw bad('it starts with "-", which git would read as an option');
  if (repo.includes('::')) throw bad('"::" is git\'s remote-helper syntax and is not allowed');

  const scheme = repo.match(SCHEME);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'https' && name !== 'ssh') throw bad(`the ${name}:// scheme is not allowed`);
    if (/\s/.test(repo)) throw bad('it contains whitespace');
    if (repo.slice(scheme[0].length).startsWith('/')) throw bad('the host name is missing');
    let url;
    try { url = new URL(repo); } catch { throw bad('it is not a well-formed URL'); }
    if (!HOST.test(url.hostname)) throw bad('the host name is not valid');
    if (url.username && !USER.test(decodeURIComponent(url.username))) throw bad('the user name is not valid');
    if (!commandLine && (url.password || (name === 'https' && url.username))) throw bad('it contains credentials');
    return repo;
  }

  if (DRIVE.test(repo)) {
    if (!commandLine) throw bad('absolute paths are not allowed here');
    return repo;
  }

  const scp = repo.match(SCP);
  if (scp) {
    if (/\s/.test(repo)) throw bad('it contains whitespace');
    if (!USER.test(scp[1])) throw bad('the user name is not valid');
    if (!HOST.test(scp[2])) throw bad('the host name is not valid');
    if (scp[3].startsWith('-')) throw bad('the path starts with "-"');
    return repo;
  }

  // Anything else is a local path.
  if (repo.includes(':')) throw bad('it is not a URL, an address or a path morf recognises');
  if (repo === '.' || repo === '..' || repo.startsWith('./') || repo.startsWith('../')) return repo;
  if (!commandLine) throw bad('a local path must be relative and start with ./ or ../');
  return repo;
}

// A branch or tag name: no leading "-", no whitespace or control characters,
// and nothing `git check-ref-format` would refuse.
export function assertSafeRef(ref) {
  const bad = why => new Error(
    `${typeof ref === 'string' ? `"${printable(ref)}"` : String(ref)} is not a valid branch or tag name: ${why}.`);
  if (typeof ref !== 'string' || ref === '') throw bad('it is empty or not text');
  if (hasControl(ref)) throw bad('it contains control characters');
  if (/\s/.test(ref)) throw bad('it contains whitespace');
  if (ref.startsWith('-')) throw bad('it starts with "-", which git would read as an option');
  if (/[~^:?*[\\]/.test(ref)) throw bad('it contains one of ~ ^ : ? * [ \\');
  if (ref.includes('..')) throw bad('it contains ".."');
  if (ref.includes('@{')) throw bad('it contains "@{"');
  if (ref === '@') throw bad('"@" alone is not a name');
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) throw bad('it has an empty path component');
  if (ref.endsWith('.')) throw bad('it ends with "."');
  for (const part of ref.split('/')) {
    if (part.startsWith('.')) throw bad('a component starts with "."');
    if (part.endsWith('.lock')) throw bad('a component ends with ".lock"');
  }
  return ref;
}

// A full commit id, as stored in the lockfile.
export function assertSafeCommit(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`"${printable(String(commit))}" is not a valid commit id: it must be 40 hexadecimal characters.`);
  }
  return commit;
}

// An item name written in a project file. It must already be in the form the
// sanitizer produces (apart from letter case), so that what is shown, what is
// matched and what is used as a file name are the same thing.
export function assertSafeItemName(name) {
  const bad = why => new Error(
    `${typeof name === 'string' ? `"${printable(name)}"` : String(name)} is not a valid item name: ${why}.`);
  if (typeof name !== 'string' || name === '') throw bad('it is empty or not text');
  if (hasControl(name)) throw bad('it contains control characters');
  let safe;
  try { safe = sanitizeName(name); } catch { throw bad('it has no usable characters'); }
  if (safe !== name.toLowerCase()) throw bad(`use "${safe}"`);
  return name;
}
