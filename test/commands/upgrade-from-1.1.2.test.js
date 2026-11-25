// Upgrading from morf 1.1.2.
//
// 1.1.2 made an ordinary git checkout. On Windows with core.autocrlf that puts
// CRLF line endings into every text file, so 1.1.2 installed CRLF files and
// recorded hashes computed over them. morf now checks out the exact bytes git
// stores (LF). An upgrade must not report those items as locally edited, and
// must not rewrite an item whose content has not changed.
//
// The test starts from a 1.1.2-style install record (version 2, no `conv`, no
// `project`) and the files 1.1.2 would have left on disk.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, tmp, cleanup, makeRepo, write, read, readJson, snapshot, projectKit } from '../helpers.js';

const m = await sandbox();
after(cleanup);
const { CLI } = projectKit(m);
const { hashPath } = await import('../../src/util/fs.js');
const { normalizeRepo } = await import('../../src/repo/url.js');

const SOURCE = {
  'skills/pdf-skill/SKILL.md': '---\nname: pdf-skill\ndescription: Work with PDFs\n---\nUse pdftotext.\n',
  'skills/pdf-skill/sub/notes.txt': 'line one\nline two\n',
  'skills/pdf-skill/logo.bin': 'BIN\u0000\n\u0000DATA\n',
  'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews code\n---\nReview the diff.\n',
  'agents/writer.md': '---\nname: writer\ndescription: Writes docs\n---\nWrite the docs.\n',
};
// What git's core.autocrlf=true does on checkout: LF -> CRLF in text files,
// binary files (those with a NUL byte) untouched.
const asCheckedOut = (text, crlf) => (crlf && !text.includes('\u0000') ? text.replace(/\n/g, '\r\n') : text);

const cli = (cwd, ...argv) => spawnSync(process.execPath, [CLI, ...argv],
  { cwd, encoding: 'utf8', env: { ...process.env, MORF_ASCII: '1' } });

// Put on disk what 1.1.2 would have installed for the claude target, and write
// the install record it would have written.
async function install112(repo, { crlf }) {
  const checkout = tmp('morf-112-checkout-');
  for (const [rel, text] of Object.entries(SOURCE)) write(checkout, rel, asCheckedOut(text, crlf));

  const items = {};
  const record = async (type, name, srcRel, destRel) => {
    for (const [rel, text] of Object.entries(SOURCE)) {
      if (rel === srcRel) write(m.home, destRel, asCheckedOut(text, crlf));
      else if (rel.startsWith(srcRel + '/')) write(m.home, join(destRel, rel.slice(srcRel.length + 1)), asCheckedOut(text, crlf));
    }
    const hash = await hashPath(join(checkout, srcRel));      // 1.1.2 hashed its checkout
    items[`${type}:${name}:claude`] = {
      type, name, repo: repo.dir, repoKey: normalizeRepo(repo.dir), target: 'claude',
      hash, sourceHash: hash, installedHash: hash, ref: null, installedAt: '2026-10-01T10:00:00.000Z',
    };
  };
  await record('skill', 'pdf-skill', 'skills/pdf-skill', '.claude/skills/pdf-skill');
  await record('agent', 'reviewer', 'agents/reviewer.md', '.claude/agents/reviewer.md');
  await record('agent', 'writer', 'agents/writer.md', '.claude/agents/writer.md');
  write(m.home, '.morf/installed.json', JSON.stringify({ version: 2, items }, null, 2));
}

for (const crlf of [true, false]) {
  const label = crlf ? 'Windows with core.autocrlf (CRLF files)' : 'LF files';

  test(`upgrade from a 1.1.2 install, ${label}: nothing is reported as edited and nothing unchanged is rewritten`, async () => {
    const repo = makeRepo(SOURCE);
    const cwd = tmp('morf-global-');
    await install112(repo, { crlf });
    const installed = snapshot(join(m.home, '.claude'));

    // list: the old record is read, and nothing shows as locally modified or missing.
    const list = cli(cwd, 'list');
    assert.equal(list.status, 0, list.stdout + list.stderr);
    assert.doesNotMatch(list.stdout, /\[MOD\]|\[MISS\]/, list.stdout);
    assert.equal((list.stdout.match(/\[OK\]/g) || []).length, 3);

    // update: every item is up to date; no file changes by a single byte.
    const up = cli(cwd, 'update', '--all');
    assert.equal(up.status, 0, up.stdout + up.stderr);
    assert.doesNotMatch(up.stdout, /\[MOD\]|\[UPD\]|\[FAIL\]|\[!\]/, up.stdout);
    assert.match(up.stdout, /Up-to-date 3\./);
    assert.deepEqual(snapshot(join(m.home, '.claude')), installed, 'an unchanged item was rewritten');
    if (crlf) assert.match(read(m.home, '.claude/agents/reviewer.md'), /\r\n/);

    // The record was migrated and refreshed, so the next run needs no special case.
    const rec = readJson(m.home, '.morf/installed.json');
    assert.equal(rec.version, 3);
    for (const r of Object.values(rec.items)) {
      assert.equal(r.project, '');
      // (A skill is copied, not converted, so its record carries no converter version.)
      if (r.type !== 'skill') assert.equal(r.conv, 2);
    }

    // install over the top behaves the same way.
    const again = cli(cwd, 'install', repo.dir, '--target', 'claude');
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /Up-to-date 3\./);
    assert.deepEqual(snapshot(join(m.home, '.claude')), installed);

    // A real upstream change is still picked up, for that item only.
    repo.commit({ 'agents/writer.md': SOURCE['agents/writer.md'] + 'And the changelog.\n' });
    const changed = cli(cwd, 'update', '--all');
    assert.equal(changed.status, 0, changed.stdout + changed.stderr);
    assert.match(changed.stdout, /writer\s+\[UPD\]/);
    assert.match(changed.stdout, /Updated 1, up-to-date 2\./);
    assert.match(read(m.home, '.claude/agents/writer.md'), /And the changelog\./);
    const after = snapshot(join(m.home, '.claude'));
    for (const key of Object.keys(installed)) {
      if (!key.endsWith('agents/writer.md')) assert.equal(after[key], installed[key], `${key} changed`);
    }

    // A file the user really edited is still detected.
    write(m.home, '.claude/agents/reviewer.md', 'my own version\n');
    const edited = cli(cwd, 'update', '--all');
    assert.match(edited.stdout, /reviewer\s+\[MOD\]\s+local changes/);
    assert.equal(read(m.home, '.claude/agents/reviewer.md'), 'my own version\n');

    cli(cwd, 'uninstall', '--all', '-y');
  });
}
