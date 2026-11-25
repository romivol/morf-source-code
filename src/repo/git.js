// The only module that starts a child process, and the only program it starts
// is git.
//
// Rules every call here follows:
//   - Values that came from outside (repo, ref, commit) are validated before
//     any process is started (repo/validate.js).
//   - On the command line they sit after an end-of-options marker, or are
//     attached to their option (--branch=<ref>), so git can never read one as
//     an option.
//   - GIT_ALLOW_PROTOCOL limits git to https, ssh and local files, so remote
//     helpers such as ext:: are refused by git itself.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { removePath } from '../util/fs.js';
import { expandRepoShorthand } from './url.js';
import { assertSafeRepo, assertSafeRef, assertSafeCommit } from './validate.js';
import { err as E } from '../util/messages.js';
import { createSpinner, printable } from '../util/log.js';

const execFileP = promisify(execFile);

const CLONE_TIMEOUT_MS = 120_000;

// The transports git may use: https and ssh remotes, and local repositories.
const ALLOWED_PROTOCOLS = 'https:ssh:file';

// Every git process morf starts, most recent last: [{ args, allowProtocol }].
// Tests read it to prove that a refused input never reached git. It records
// the transport restriction only, never the environment: the environment holds
// the user's secrets, and a failing assertion would print them.
export const gitCalls = [];

function isSshRemote(repo) {
  if (typeof repo !== 'string') return false;
  if (repo.startsWith('ssh://')) return true;
  return /^[^@/\s]+@[^:\s/]+:/.test(repo);
}

function gitEnv(repo = null) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS };
  if (repo && isSshRemote(repo)) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  return env;
}

// The single place a process is spawned.
async function runGit(args, { env = gitEnv(), timeout = CLONE_TIMEOUT_MS } = {}) {
  gitCalls.push({ args, allowProtocol: env.GIT_ALLOW_PROTOCOL });
  const { stdout } = await execFileP('git', args, { timeout, env });
  return stdout.trim();
}

export async function assertGitAvailable() {
  try {
    await runGit(['--version'], { timeout: 10_000 });
  } catch {
    throw new Error(E.gitMissing);
  }
}

// Validate what the caller passed and return the URL git will be given.
// Throws before anything is spawned.
function checked(repo, ref, commit) {
  const url = expandRepoShorthand(repo);
  assertSafeRepo(url, { commandLine: true });
  if (ref !== null && ref !== undefined) assertSafeRef(ref);
  if (commit !== null && commit !== undefined) assertSafeCommit(commit);
  return url;
}

export async function cloneTemp(repo, ref = null) {
  const url = checked(repo, ref, null);
  const dir = await fs.mkdtemp(join(tmpdir(), 'morf-'));
  const cloneArgs = ['clone', '--depth', '1'];
  if (ref) cloneArgs.push(`--branch=${ref}`);
  cloneArgs.push('--', url, dir);

  const spinner = createSpinner(`Cloning ${printable(repo)}...`);
  try {
    await runGit(cloneArgs, { env: gitEnv(url) });
    spinner.stop();
    return dir;
  } catch (err) {
    spinner.stop();
    await removePath(dir).catch(() => {});
    throw classifyGitError(err, repo, ref);
  }
}

export async function withTempClone(repo, refOrFn, fn) {
  let ref = null;
  if (typeof refOrFn === 'function') {
    fn = refOrFn;
  } else {
    ref = refOrFn;
  }
  const dir = await cloneTemp(repo, ref);
  try {
    return await fn(dir);
  } finally {
    await removePath(dir).catch(() => {});
  }
}

// ── project mode: exact, byte-faithful checkouts ──────────────────────────────

// Attributes that switch off every checkout-time rewrite, so the working tree
// holds exactly the bytes git stores — whatever the user's core.autocrlf is and
// whatever the repo's own .gitattributes say. (.git/info/attributes wins over
// both.) Content hashes in the lockfile are therefore the same on every OS.
const RAW_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n';

async function setRawCheckout(dir) {
  await fs.mkdir(join(dir, '.git', 'info'), { recursive: true });
  await fs.writeFile(join(dir, '.git', 'info', 'attributes'), RAW_ATTRIBUTES, 'utf8');
}

// git inside a checkout morf created. `dir` is always morf's own temp directory.
function git(dir, args, env) {
  return runGit(['-c', 'core.autocrlf=false', '-C', dir, ...args], { env });
}

// Open a temporary raw checkout of `repo`.
//   { ref }     the tip of a branch or tag (or the default branch when null)
//   { commit }  exactly that commit — never anything else
// Returns { dir, commit, branch, via, close }. `branch` is the checked-out branch
// name, or null for a tag / detached checkout. `via` says how a pinned commit
// was obtained: 'fetch' (asked the host for that commit) or 'clone' (the full
// clone fallback). `fullClone: true` skips the direct fetch.
export async function openClone(repo, { ref = null, commit = null, label = null, fullClone = false } = {}) {
  const url = checked(repo, ref, commit);
  const env = gitEnv(url);
  const shown = printable(label || repo);
  const spinner = createSpinner(`Fetching ${shown}${commit ? ` @ ${commit.slice(0, 7)}` : ''}...`);
  let dir = await fs.mkdtemp(join(tmpdir(), 'morf-'));
  const fail = async (e) => {
    spinner.stop();
    await removePath(dir).catch(() => {});
    throw e;
  };

  try {
    if (commit) {
      // Ask for the exact commit. Many hosts allow that; if this one refuses,
      // fall back to a full clone and check the commit out from it.
      let fetched = false;
      if (!fullClone) {
        try {
          await runGit(['init', '-q', '--', dir], { env });
          await setRawCheckout(dir);
          await git(dir, ['fetch', '-q', '--depth', '1', '--', url, commit], env);
          await git(dir, ['checkout', '-q', 'FETCH_HEAD'], env);
          fetched = true;
        } catch { /* fall through to the full clone */ }
      }

      if (!fetched) {
        await removePath(dir).catch(() => {});
        dir = await fs.mkdtemp(join(tmpdir(), 'morf-'));
        try {
          await runGit(['clone', '-q', '--no-checkout', '--', url, dir], { env });
        } catch (e) {
          return await fail(classifyGitError(e, repo, null));
        }
        await setRawCheckout(dir);
        try {
          // `git checkout` does not honour --end-of-options; `git switch` does.
          await git(dir, ['switch', '-q', '--detach', '--end-of-options', commit], env);
        } catch {
          return await fail(new Error(E.commitUnavailable(commit, label || repo)));
        }
      }

      const head = await git(dir, ['rev-parse', 'HEAD'], env);
      if (head !== commit) return await fail(new Error(E.commitUnavailable(commit, label || repo)));
      spinner.stop();
      return { dir, commit, branch: null, via: fetched ? 'fetch' : 'clone', close: () => removePath(dir).catch(() => {}) };
    }

    const args = ['clone', '-q', '--depth', '1', '--no-checkout'];
    if (ref) args.push(`--branch=${ref}`);
    args.push('--', url, dir);
    try {
      await runGit(args, { env });
    } catch (e) {
      return await fail(classifyGitError(e, repo, ref));
    }
    await setRawCheckout(dir);
    await git(dir, ['reset', '-q', '--hard', 'HEAD'], env);
    const head = await git(dir, ['rev-parse', 'HEAD'], env);
    let branch = null;
    try {
      const b = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
      if (b && b !== 'HEAD') branch = b;
    } catch { /* detached */ }
    spinner.stop();
    return { dir, commit: head, branch, via: 'clone', close: () => removePath(dir).catch(() => {}) };
  } catch (e) {
    return await fail(e);
  }
}

function classifyGitError(cause, repo, ref) {
  const stderr = (cause.stderr || '').toLowerCase();

  if (ref && (
    stderr.includes('remote branch') ||
    stderr.includes(`'${ref.toLowerCase()}'`) ||
    stderr.includes('not found in upstream') ||
    stderr.includes('invalid branch') ||
    stderr.includes('could not find remote branch')
  )) {
    return new Error(E.badRef(ref, repo));
  }

  if (
    stderr.includes('authentication failed') ||
    stderr.includes('could not read username') ||
    stderr.includes('permission denied (publickey)') ||
    stderr.includes('terminal prompts disabled') ||
    stderr.includes('host key verification failed')
  ) {
    return new Error(E.authFailed(repo));
  }

  if (
    stderr.includes('repository not found') ||
    stderr.includes('does not exist') ||
    stderr.includes('access denied') ||
    (!ref && stderr.includes('not found'))
  ) {
    return new Error(E.repoNotFound(repo));
  }

  if (
    stderr.includes('could not resolve host') ||
    stderr.includes('unable to connect') ||
    stderr.includes('network') ||
    stderr.includes('timeout') ||
    cause.killed
  ) {
    return new Error(E.network);
  }

  // git's own text can carry bytes sent by the remote: never print it raw.
  const relevantLine = (cause.stderr || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('Cloning'));
  return new Error(printable(relevantLine || cause.message || 'git clone failed for an unknown reason.'));
}
