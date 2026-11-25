// Shared helpers for the project-mode tests.
//
// The install record lives under the home directory, and its path is fixed when
// the source modules are first imported. So a test file must call `sandbox()`
// before importing anything from src/: it points HOME / USERPROFILE at a temp
// directory, then loads the modules.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const made = [];

export function tmp(prefix = 'morf-test-') {
  // The real path: on macOS the temp dir is a symlink, and on Windows it can
  // be an 8.3 short name; a child process would report a different spelling.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanup() {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
}

// Point the home directory at a temp dir and import the source modules.
export async function sandbox() {
  const home = tmp('morf-home-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CI;
  const mods = await Promise.all([
    import('../src/commands/init.js'),
    import('../src/commands/sync.js'),
    import('../src/commands/project-install.js'),
    import('../src/commands/project-uninstall.js'),
    import('../src/project/project-file-and-lockfile.js'),
    import('../src/repo/url.js'),
    import('../src/install/install-record.js'),
    import('../src/util/fs.js'),
    import('../src/repo/git.js'),
    import('../src/project/approve.js'),
    import('../src/repo/validate.js'),
    import('../src/util/log.js'),
  ]);
  return Object.assign({ home }, ...mods);
}

// The fixtures every project-mode test file starts from. `m` is the result of
// sandbox().
export function projectKit(m) {
  const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const NAMES = () => ({ skill: [], agent: [], rule: [], prompt: [], hook: [], mcp: [] });
  const names = (over) => ({ ...NAMES(), ...over });
  const ctx = (root, io, morfVersion = '9.9.9') => ({ root, cwd: root, io: io || fakeIo(), morfVersion });

  // The repo as it is stored in the project files (relative to the project).
  const stored = (root, repo) => m.cleanRepoForProject(repo.dir, root, root).stored;

  // A fresh project directory with an empty project file.
  async function newProject() {
    const root = tmp('morf-proj-');
    await m.writeProjectFile(root, m.emptyProject());
    return root;
  }

  // Non-interactive install with both approval flags.
  function install(root, repo, over = {}) {
    return run(() => m.projectInstallCommand({
      repoArg: repo.dir, names: NAMES(), all: false, targets: ['claude'], force: false, ref: null,
      yes: true, allowExec: true, ...over,
    }, ctx(root)));
  }

  function sync(root, flags = {}, io = null, version) {
    return run(() => m.syncCommand({ yes: true, allowExec: true, ...flags }, ctx(root, io, version)));
  }

  // A project whose morf.json was written by hand (no lockfile, nothing installed).
  async function handWritten(repo, items, targets = ['claude']) {
    const root = tmp('morf-proj-');
    await m.writeProjectFile(root, { sources: [{ repo: stored(root, repo), ref: 'main', targets, items }] });
    return root;
  }

  return { CLI, NAMES, names, ctx, stored, newProject, install, sync, handWritten };
}

export function write(root, rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

export const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
export const readJson = (root, rel) => JSON.parse(read(root, rel));

export function exists(root, rel) {
  try { statSync(join(root, rel)); return true; } catch { return false; }
}

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export const FIXTURE = {
  'skills/pdf-skill/SKILL.md': '---\nname: pdf-skill\ndescription: Work with PDFs\n---\nUse pdftotext.\n',
  'skills/pdf-skill/sub/notes.txt': 'nested\n',
  'agents/bug-finder.md': '---\nname: bug-finder\ndescription: Finds bugs\ntools: Read, Grep\n---\nFind bugs.\n',
  'rules/ts-style.md': '---\ndescription: TS conventions\nglobs: src/**/*.ts\n---\n- Use named exports\n',
  'prompts/fix-issue.md': '---\ndescription: Fix an issue\n---\nFix $ARGUMENTS\n',
  'hooks/guard.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }] } }, null, 2),
  '.mcp.json': JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', 'ctx7'], env: { API_KEY: '${API_KEY}' } } } }, null, 2),
};

// A local git repository with one commit. `commit(files)` adds another.
export function makeRepo(files = FIXTURE) {
  const dir = tmp('morf-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  const commit = (changes, message = 'change') => {
    for (const [rel, text] of Object.entries(changes)) {
      if (text === null) rmSync(join(dir, rel), { recursive: true, force: true });
      else write(dir, rel, text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const first = commit(files, 'fixture');

  // Add entries straight to git's index and commit them, without creating
  // them on disk. This is how a test builds things a normal checkout on this
  // machine might not allow: a symbolic link (mode 120000, content = target),
  // a submodule (mode 160000, content = a commit id), or an awkward file name.
  const commitEntries = (entries, message = 'entries') => {
    for (const { mode = '100644', path, content = '' } of entries) {
      const sha = mode === '160000'
        ? content
        : execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: content, encoding: 'utf8' }).trim();
      git(dir, 'update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`);
    }
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };

  return { dir, first, commit, commitEntries, head: () => git(dir, 'rev-parse', 'HEAD') };
}

// A fake terminal. `answers` are returned to successive questions.
export function fakeIo({ tty = false, env = {}, answers = [] } = {}) {
  const asked = [];
  const queue = [...answers];
  return {
    isTTY: tty,
    env,
    asked,
    ask: async (q) => { asked.push(q); return queue.length ? queue.shift() : ''; },
  };
}

// Run fn with console output captured. Returns { code, out }.
export async function run(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, write: process.stdout.write };
  console.log = console.warn = console.error = (...a) => { lines.push(a.join(' ')); };
  // Capture only text. The test runner sends its own results to the parent
  // process as binary frames on this same stream; swallowing those would make
  // tests vanish from the report.
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return orig.write.call(process.stdout, chunk, ...rest);
    lines.push(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, out: lines.join('\n') };
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    process.stdout.write = orig.write;
  }
}

// Every file under the given directories with a hash of its bytes — to prove
// that a command changed nothing.
export function snapshot(...dirs) {
  const out = {};
  const walk = (base, dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(base, p);
      else out[`${base}:${relative(base, p).replace(/\\/g, '/')}`] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  for (const d of dirs) walk(d, d);
  return out;
}
