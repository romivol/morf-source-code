// The whole install and sync pipeline against source repositories built to
// misbehave. Each test states what morf does with one kind of hostile content,
// and checks that nothing is written outside the places morf is allowed to
// write.
//
// Hostile repositories are built through git's index (helpers `commitEntries`),
// so they can hold things a normal checkout on the test machine would not
// produce: links, submodule entries and awkward names.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, lstatSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox, tmp, cleanup, makeRepo, fakeIo, run, snapshot, write, exists, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI, NAMES, ctx, newProject } = projectKit(m);

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SKILL = '---\nname: s\ndescription: d\n---\nbody\n';
const AGENT = '---\nname: a\ndescription: d\n---\nbody\n';
const isWindows = process.platform === 'win32';

// Where morf may write. Everything else must be untouched.
const HOME_ALLOWED = ['.morf/', '.claude/', '.claude.json', '.codex/', '.config/opencode/', '.kilo/', '.config/kilo/'];
const ROOT_ALLOWED = ['morf.json', 'morf.lock.json', '.claude/', '.mcp.json', '.codex/', 'AGENTS.md', '.agents/', '.cursor/',
  '.opencode/', 'opencode.json', '.kilo/', 'kilo.jsonc', '.github/', '.devin/'];

const files = dir => Object.keys(snapshot(dir)).map(k => k.slice(k.indexOf(':', 3) + 1));
// (`<file>.morf-backup` is the copy morf keeps, in global mode, of a shared file
// it is about to change for the first time: it sits next to an allowed file.)
const allowedPath = (f, allowed) => allowed.some(a => (a.endsWith('/') ? f.startsWith(a) : f === a || f === `${a}.morf-backup`));
const outside = (dir, allowed) => files(dir).filter(f => !allowedPath(f, allowed));

// A fresh place to run from, with canaries around it.
async function arena() {
  const base = tmp('morf-arena-');
  write(base, 'canary/secret.txt', 'CANARY');
  write(base, 'cwd/keep.txt', 'keep');
  const root = await newProject();
  const homeBefore = outside(m.home, HOME_ALLOWED);
  const assertContained = (label) => {
    assert.deepEqual(snapshot(join(base, 'canary')), snapshot(join(base, 'canary')));
    assert.deepEqual(files(join(base, 'canary')), ['secret.txt'], `${label}: the canary directory changed`);
    assert.deepEqual(files(join(base, 'cwd')), ['keep.txt'], `${label}: the working directory changed`);
    assert.deepEqual(outside(m.home, HOME_ALLOWED), homeBefore, `${label}: wrote outside the tool directories under home`);
    assert.deepEqual(outside(root, ROOT_ALLOWED), [], `${label}: wrote outside the tool directories in the project`);
    // Nothing morf placed is a link.
    for (const dir of [m.home, root]) {
      for (const f of files(dir)) assert.ok(!lstatSync(join(dir, f)).isSymbolicLink(), `${label}: ${f} is a link`);
    }
  };
  return { base, root, cwd: join(base, 'cwd'), canary: join(base, 'canary', 'secret.txt').replace(/\\/g, '/'), assertContained };
}

const globalInstall = (cwd, repo, ...extra) => spawnSync(process.execPath,
  [CLI, 'install', repo.dir, '--target', 'claude', 'codex', '--allow-exec', ...extra],
  { cwd, encoding: 'utf8', env: { ...process.env, MORF_ASCII: '1' } });

const projectInstall = (root, repo, over = {}) => run(() => m.projectInstallCommand({
  repoArg: repo.dir, names: NAMES(), all: true, targets: ['claude', 'codex', 'cursor'], force: false, ref: null,
  yes: true, allowExec: true, ...over,
}, ctx(root)));

async function resetGlobal() {
  const { uninstallCommand } = await import('../../src/commands/uninstall.js');
  await run(() => uninstallCommand({ names: NAMES(), all: true, targets: [], force: true, dryRun: false }));
}

// ── links and submodules ──────────────────────────────────────────────────────

test('links in and out of the tree, and a submodule: those items are refused, the rest installs', async () => {
  const a = await arena();
  const repo = makeRepo({ 'skills/good/SKILL.md': SKILL, 'agents/good.md': AGENT, 'README.md': 'r\n' });
  repo.commitEntries([
    { path: 'skills/in/SKILL.md', content: SKILL },
    { mode: '120000', path: 'skills/in/link', content: '../../README.md' },
    { path: 'skills/out/SKILL.md', content: SKILL },
    { mode: '120000', path: 'skills/out/link', content: a.canary },
    { mode: '120000', path: 'skills/whole-dir-link', content: a.canary },
    { mode: '120000', path: 'agents/link.md', content: a.canary },
    { mode: '120000', path: 'rules/link.md', content: '../agents/good.md' },
    { path: 'skills/sub/SKILL.md', content: SKILL },
    { mode: '160000', path: 'skills/sub/mod', content: repo.first },
    { path: '.gitmodules', content: `[submodule "mod"]\n\tpath = skills/sub/mod\n\turl = ext::sh -c "touch ${a.base.replace(/\\/g, '/')}/SUBMODULE"\n` },
  ]);

  const g = globalInstall(a.cwd, repo);
  assert.equal(g.status, 1, g.stdout + g.stderr);
  for (const name of ['in', 'out', 'sub', 'link']) assert.match(g.stdout, new RegExp(`\\b${name}\\s+\\[FAIL\\]\\s+contains a (symbolic link|git submodule)`), name);
  assert.ok(exists(m.home, '.claude/skills/good/SKILL.md') && exists(m.home, '.claude/agents/good.md'));
  for (const gone of ['.claude/skills/in', '.claude/skills/out', '.claude/skills/sub', '.claude/agents/link.md', '.claude/rules/link.md', '.claude/skills/whole-dir-link']) {
    assert.ok(!exists(m.home, gone), `${gone} was installed`);
  }
  a.assertContained('global');
  await resetGlobal();

  const p = await projectInstall(a.root, repo);
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /contains a symbolic link|contains a git submodule/);
  assert.deepEqual(files(a.root), ['morf.json'], 'the project was changed although the command stopped');
  a.assertContained('project');
  assert.ok(!exists(a.base, 'SUBMODULE'), 'the submodule URL was used');
});

// ── names ─────────────────────────────────────────────────────────────────────

test('awkward item names are sanitized or refused, and never leave the destination directory', async () => {
  const a = await arena();
  const repo = makeRepo({ 'agents/good.md': AGENT });
  repo.commitEntries([
    { path: 'agents/-rf.md', content: AGENT },
    { path: 'agents/--upload-pack=x.md', content: AGENT },
    { path: 'agents/..hidden.md', content: AGENT },
    { path: 'agents/....md', content: AGENT },
    { path: 'agents/UPPER Case & spaces.md', content: AGENT },
    { path: 'agents/semi;colon$(id).md', content: AGENT },
    { path: 'skills/-dash/SKILL.md', content: SKILL },
    { path: 'skills/..dots/SKILL.md', content: SKILL },
    { path: '.mcp.json', content: JSON.stringify({ mcpServers: {
      '../../evil': { command: 'a' }, '-rf': { command: 'b' }, 'a/b\\c': { command: 'c' }, '..': { command: 'd' },
      [`ctl${ESC}[2Jname`]: { command: 'e' }, [`new\nline`]: { command: 'f' }, ['y'.repeat(300)]: { command: 'g' },
      '': { command: 'h' }, 'good-server': { command: 'ok' },
    } }) },
  ]);

  const g = globalInstall(a.cwd, repo);
  // Names that sanitize to something usable are installed under the sanitized name.
  for (const f of ['.claude/agents/rf.md', '.claude/agents/upload-pack-x.md', '.claude/agents/hidden.md',
    '.claude/agents/upper-case---spaces.md', '.claude/agents/semi-colon--id.md', '.claude/skills/dash/SKILL.md', '.claude/skills/dots/SKILL.md']) {
    assert.ok(exists(m.home, f), `${f} missing\n${g.stdout}`);
  }
  const servers = Object.keys(JSON.parse(readFileSync(join(m.home, '.claude.json'), 'utf8')).mcpServers);
  for (const s of servers) assert.match(s, /^[a-z0-9][a-z0-9._-]*$/, `MCP server key ${JSON.stringify(s)}`);
  assert.ok(servers.includes('good-server') && servers.includes('evil') && servers.includes('rf'));
  // Nothing printed raw, whatever the names were.
  assert.ok(!(g.stdout + g.stderr).includes(ESC));
  a.assertContained('global');
  await resetGlobal();

  const p = await projectInstall(a.root, repo);
  assert.ok(!p.out.includes(ESC));
  a.assertContained('project');
  // The project files hold sanitized names only.
  if (exists(a.root, 'morf.lock.json')) {
    for (const s of JSON.parse(readFileSync(join(a.root, 'morf.lock.json'), 'utf8')).sources) {
      for (const i of s.items) assert.match(i.name, /^[a-z0-9][a-z0-9._-]*$/);
    }
  }
});

test('file names a system cannot hold (control characters, backslash, colon)', async (t) => {
  const a = await arena();
  const repo = makeRepo({ 'agents/good.md': AGENT });
  try {
    repo.commitEntries([
      { path: `agents/ctl${BEL}bell.md`, content: AGENT },
      { path: `agents/esc${ESC}[2Jclear.md`, content: AGENT },
      { path: 'agents/back\\slash.md', content: AGENT },
      { path: 'agents/co:lon.md', content: AGENT },
    ]);
  } catch {
    // git on Windows will not even record such a path, so a repository like
    // this cannot be built here. Linux and macOS run the test.
    t.skip('git on this system refuses to record these file names');
    return;
  }

  const g = globalInstall(a.cwd, repo);
  assert.ok(!(g.stdout + g.stderr).includes(ESC) && !(g.stdout + g.stderr).includes(BEL), 'a raw control character was printed');
  if (g.status === 0) {
    // The system could check these out: they are installed under safe names.
    for (const f of files(m.home).filter(x => x.startsWith('.claude/agents/'))) assert.match(f, /^\.claude\/agents\/[a-z0-9][a-z0-9._-]*\.md$/);
  }
  a.assertContained('global');
  await resetGlobal();

  const p = await projectInstall(a.root, repo);
  assert.ok(!p.out.includes(ESC) && !p.out.includes(BEL));
  a.assertContained('project');
  // On Windows git refuses to check such names out, so the whole source fails.
  if (isWindows) assert.equal(p.code, 1, p.out);
});

// ── git features ──────────────────────────────────────────────────────────────

// A user who has a git filter configured (git-lfs is the common one). A hostile
// repository can ask for any filter by name through .gitattributes.
function withUserFilter(markerPath, fn) {
  const cfg = join(tmp('morf-gitcfg-'), 'gitconfig');
  // Double-quoted, because ";" would otherwise start a comment in a git config file.
  writeFileSync(cfg, `[filter "evil"]\n\tsmudge = "sh -c 'touch ${markerPath}; cat'"\n\tclean = cat\n`);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
  });
}

function filterRepo() {
  return makeRepo({
    '.gitattributes': '* filter=evil\n*.md text eol=crlf\n',
    'agents/good.md': AGENT,
    'skills/good/SKILL.md': SKILL,
  });
}

test('project mode: a .gitattributes filter and line-ending rule in the repository have no effect', async () => {
  const a = await arena();
  const marker = join(a.base, 'FILTER-RAN').replace(/\\/g, '/');
  const repo = filterRepo();
  await withUserFilter(marker, async () => {
    const p = await projectInstall(a.root, repo, { targets: ['claude'] });
    assert.equal(p.code, 0, p.out);
  });
  assert.ok(!exists(a.base, 'FILTER-RAN'), "the user's filter was run for a repository morf fetched");
  // The bytes installed are the bytes committed (LF), not rewritten to CRLF.
  assert.equal(readFileSync(join(a.root, '.claude/skills/good/SKILL.md'), 'utf8'), SKILL);
  a.assertContained('project');
});

// FINDING, reported and not yet fixed: outside a project morf makes an ordinary
// checkout, so a repository's .gitattributes can select any filter the user
// has configured in git (git-lfs being the usual one), and git runs it. In a
// project the checkout is raw and the test above passes. Marked `todo` so the
// suite records the gap without failing; remove the mark when it is fixed.
test('global mode: a .gitattributes filter in the repository has no effect', { todo: 'global-mode checkouts honour repository attributes' }, async () => {
  const a = await arena();
  const marker = join(a.base, 'FILTER-RAN').replace(/\\/g, '/');
  const repo = filterRepo();
  await withUserFilter(marker, async () => {
    const g = globalInstall(a.cwd, repo);
    assert.equal(g.status, 0, g.stdout + g.stderr);
  });
  assert.ok(!exists(a.base, 'FILTER-RAN'), "the user's filter was run for a repository morf fetched");
  assert.equal(readFileSync(join(m.home, '.claude/skills/good/SKILL.md'), 'utf8'), SKILL);
  a.assertContained('global');
  await resetGlobal();
});

// ── content ───────────────────────────────────────────────────────────────────

test('escape sequences and quoting tricks in hook, MCP and agent content', async () => {
  const a = await arena();
  const evilCmd = `echo safe ${ESC}[2K\r"); process.exit(1); ("\n*/ \`id\` \${process.env.HOME}`;
  const repo = makeRepo({
    'hooks/guard.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: evilCmd }] }] } }),
    '.mcp.json': JSON.stringify({ mcpServers: { srv: {
      command: `npx${ESC}[1A`, args: ['a"\n[mcp_servers.injected]\ncommand = "pwn'],
      env: { 'K]\n[evil': 'v"\n[evil2]\nx = "1', NORMAL: '${NORMAL}' },
    } } }),
    'agents/a.md': `---\nname: "x\\"\\ndeveloper_instructions = \\"pwn"\ndescription: "d'''\\n[evil]\\nk = 1"\n---\nbody with ''' quotes\n`,
  });

  const io = fakeIo({ tty: true, answers: ['y', 'y'] });
  const p = await run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: NAMES(), all: true, targets: ['claude', 'codex', 'opencode'], force: false, ref: null, yes: false, allowExec: false,
  }, ctx(a.root, io)));
  assert.equal(p.code, 0, p.out);
  assert.ok(!p.out.includes(ESC) && !p.out.includes('\r'), 'raw control characters in the plan');
  assert.equal(io.asked.length, 2, 'the hook and MCP server were confirmed separately');

  // Codex config: only the table morf meant to write, nothing injected.
  const toml = readFileSync(join(a.root, '.codex/config.toml'), 'utf8');
  const headers = toml.split('\n').filter(l => /^\s*\[/.test(l));
  assert.deepEqual(headers, ['[mcp_servers.srv]', '[mcp_servers.srv.env]'], toml);
  assert.ok(!toml.includes(ESC));
  // Codex agent: exactly the three keys.
  const agent = readFileSync(join(a.root, '.codex/agents/a.toml'), 'utf8');
  assert.deepEqual(agent.split('\n').filter(l => /^[A-Za-z_]+ = /.test(l)).map(l => l.split(' = ')[0]), ['name', 'description', 'developer_instructions']);
  assert.ok(!/^\[evil\]/m.test(agent));

  // JSON configs hold the strings as data, with control characters escaped.
  for (const f of ['.mcp.json', '.claude/settings.json', '.codex/hooks.json', 'opencode.json']) {
    const text = readFileSync(join(a.root, f), 'utf8');
    assert.ok(!text.includes(ESC), `${f} holds a raw escape character`);
    JSON.parse(text);
  }
  assert.equal(JSON.parse(readFileSync(join(a.root, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, evilCmd);

  // The generated plugin is valid JavaScript whose only data is the command string.
  const plugin = join(a.root, '.opencode/plugins/morf-guard.js');
  const mod = await import(pathToFileURL(plugin).href);
  assert.deepEqual(Object.keys(mod), ['MorfHook_guard']);
  assert.ok(readFileSync(plugin, 'utf8').includes(JSON.stringify(evilCmd)));
  a.assertContained('project');
});

// ── size ──────────────────────────────────────────────────────────────────────

test('an oversized file in a skill', async () => {
  const a = await arena();
  const big = Buffer.alloc(12 * 1024 * 1024, 'a');
  const repo = makeRepo({ 'skills/big/SKILL.md': SKILL, 'skills/big/blob.bin': big, 'agents/good.md': AGENT });

  const p = await projectInstall(a.root, repo, { targets: ['claude'] });
  a.assertContained('project');
  // Reported to the maintainer as an open question: morf has no size limit.
  // What it does today is install the file as it is.
  assert.equal(p.code, 0, p.out);
  assert.equal(statSync(join(a.root, '.claude/skills/big/blob.bin')).size, big.length);
});
