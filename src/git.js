import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { removePath } from './fsops.js';
import { err as E } from './messages.js';
import { createSpinner } from './log.js';

const execFileP = promisify(execFile);

const CLONE_TIMEOUT_MS = 120_000;

export async function assertGitAvailable() {
  try {
    await execFileP('git', ['--version'], { timeout: 10_000 });
  } catch {
    throw new Error(E.gitMissing);
  }
}

function isSshRemote(repo) {
  if (typeof repo !== 'string') return false;
  if (repo.startsWith('ssh://')) return true;
  return /^[^@/\s]+@[^:\s/]+:/.test(repo);
}

export async function cloneTemp(repo, ref = null) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'morf-'));
  const cloneArgs = ['clone', '--depth', '1'];
  if (ref) cloneArgs.push('--branch', ref);
  cloneArgs.push(repo, dir);

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (isSshRemote(repo)) {
    env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  }

  const spinner = createSpinner(`Cloning ${repo}...`);
  try {
    await execFileP('git', cloneArgs, { timeout: CLONE_TIMEOUT_MS, env });
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

  const relevantLine = (cause.stderr || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('Cloning'));
  return new Error(relevantLine || cause.message || 'git clone failed for an unknown reason.');
}
