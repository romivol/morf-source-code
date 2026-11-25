// The environment holds the user's secrets (tokens, keys). Nothing morf keeps
// for inspection, prints, or writes may contain it. This file fails if the
// record of child-process calls, an error, the plan, or any written file ever
// carries an environment value.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, tmp, cleanup, makeRepo, fakeIo, run, snapshot, projectKit } from '../helpers.js';

// Planted before anything else runs, so every code path sees them.
const CANARIES = {
  MORF_TEST_SECRET_TOKEN: 'canary-9f3c2a7d51e84b06-token',
  GITLAB_TEST_PAT: 'glpat-canary-0f4e8a6b2c1d-not-real',
  AWS_SECRET_ACCESS_KEY: 'canary/AbCdEf0123456789+not/real/KEY',
};
Object.assign(process.env, CANARIES);

const m = await sandbox();
after(() => {
  for (const k of Object.keys(CANARIES)) delete process.env[k];
  cleanup();
});
const { CLI, NAMES, ctx, newProject } = projectKit(m);

const leaks = text => Object.values(CANARIES).filter(v => String(text).includes(v));

test('the record of git calls holds arguments and the transport list, never the environment', async () => {
  const repo = makeRepo();
  m.gitCalls.length = 0;
  const a = await m.openClone(repo.dir, { ref: 'main' });
  await a.close();
  const b = await m.openClone(repo.dir, { commit: repo.first, fullClone: true });
  await b.close();
  await m.assertGitAvailable();
  await m.openClone(repo.dir, { commit: 'd'.repeat(40) }).catch(() => {});

  assert.ok(m.gitCalls.length > 5);
  for (const call of m.gitCalls) {
    assert.deepEqual(Object.keys(call).sort(), ['allowProtocol', 'args'], 'a call record gained a field');
    assert.ok(Array.isArray(call.args) && call.args.every(x => typeof x === 'string'));
    assert.equal(typeof call.allowProtocol, 'string');
  }
  const dump = JSON.stringify(m.gitCalls);
  assert.deepEqual(leaks(dump), []);
  // No environment variable name appears as a key anywhere in the record.
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'GIT_TERMINAL_PROMPT', 'env']) {
    assert.ok(!dump.includes(`"${key}"`), `the record mentions ${key}`);
  }
});

test('a failed git call produces an error without the environment in it', async () => {
  const err = await m.openClone(join(tmp(), 'no-such-repo'), { ref: 'main' }).then(() => null, e => e);
  assert.ok(err instanceof Error);
  const everything = [err.message, err.stack, JSON.stringify(err, Object.getOwnPropertyNames(err))].join('\n');
  assert.deepEqual(leaks(everything), []);
  assert.equal(err.env, undefined);
  assert.equal(err.options, undefined);
});

test('nothing printed and nothing written by a full install and sync contains an environment value', async () => {
  const repo = makeRepo();
  const root = await newProject();
  const io = fakeIo({ tty: true, answers: ['y', 'y'] });
  const install = await run(() => m.projectInstallCommand({
    repoArg: repo.dir, names: NAMES(), all: true, targets: ['claude', 'codex', 'cursor', 'opencode', 'kilo', 'copilot', 'windsurf'],
    force: false, ref: null, yes: false, allowExec: false,
  }, ctx(root, io)));
  assert.equal(install.code, 0, install.out);
  const sync = await run(() => m.syncCommand({ check: true }, ctx(root)));
  const bad = await run(() => m.syncCommand({}, ctx(tmp())));
  assert.deepEqual(leaks([install.out, sync.out, bad.out].join('\n')), []);

  for (const dir of [root, m.home]) {
    for (const key of Object.keys(snapshot(dir))) {
      const rel = key.slice(key.indexOf(':', 3) + 1);
      assert.deepEqual(leaks(readFileSync(join(dir, rel), 'utf8')), [], `${rel} contains an environment value`);
    }
  }
  // The terminal object the approval gate receives carries one variable only.
  assert.deepEqual(Object.keys(m.defaultIo().env), ['CI']);
});

test('the real CLI never prints an environment value, on success or on failure', () => {
  const repo = makeRepo();
  const cwd = tmp('morf-global-');
  const env = { ...process.env, MORF_ASCII: '1' };
  for (const argv of [
    ['--help'], ['list'], ['config', 'list'],
    ['install', repo.dir, '--target', 'claude', '--allow-exec'],
    ['install', repo.dir, '--target', 'claude', '--dry-run'],
    ['install', 'ext::sh -c id', '--target', 'claude'],
    ['install', join(cwd, 'missing-repo'), '--target', 'claude'],
    ['update', '--all', '--allow-exec'], ['sync'], ['uninstall', '--all', '-y'], ['no-such-command'],
  ]) {
    const res = spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: 'utf8', env });
    assert.deepEqual(leaks(res.stdout + res.stderr), [], `morf ${argv.join(' ')}`);
  }
});

test('no source or test file prints, serialises or stores the environment as a whole', () => {
  // The only places that may read process.env, and what they may take from it.
  const ALLOWED = {
    'src/repo/git.js': 1,           // builds the environment passed to git
    'src/project/approve.js': 1,    // reads CI
    'src/util/log.js': 2,           // NO_COLOR, MORF_ASCII
    'src/util/banner.js': 1,        // NO_COLOR
  };
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const found = {};
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith('.js')) {
        const text = readFileSync(join(root, rel), 'utf8');
        const n = (text.match(/process\.env/g) || []).length;
        if (n) found[rel] = n;
        // Whole-environment uses that could end up in output.
        for (const bad of [/JSON\.stringify\(\s*process\.env/, /console\.\w+\([^)]*process\.env\s*[,)]/, /log\.\w+\([^)]*process\.env\s*[,)]/,
          /inspect\(\s*process\.env/, /Object\.(entries|values)\(\s*process\.env/]) {
          assert.ok(!bad.test(text), `${rel} uses the whole environment: ${bad}`);
        }
      }
    }
  };
  walk('src');
  walk('bin');
  assert.deepEqual(found, ALLOWED);

  // git.js may spread the environment only into the object it hands to git.
  const git = readFileSync(join(root, 'src/repo/git.js'), 'utf8');
  assert.match(git, /const env = \{ \.\.\.process\.env, GIT_TERMINAL_PROMPT/);
  assert.match(git, /gitCalls\.push\(\{ args: full, allowProtocol: env\.GIT_ALLOW_PROTOCOL \}\)/);
});
