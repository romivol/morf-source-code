// The lockfile's content hash must be the same on Linux, macOS and Windows.
// CI runs this file on all three: each computes the hash of the same fixture
// and compares it with the constant below, so the three systems must agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { portableHashPath, portableDigest } from '../src/fsops.js';

// The fixture is built from these exact bytes at test time, so a checkout's
// line-ending settings cannot alter it. It is chosen to expose the things that
// differ between systems:
//   - nested directories            (path separator: / vs \)
//   - "B.txt" and "a.txt"           (byte order puts B first; locale order a first)
//   - "a.b" beside directory "a"    ('.' sorts before '/', but after '\' would not)
//   - LF, CRLF and binary content   (bytes must be hashed untouched)
const FIXTURE = {
  'SKILL.md': Buffer.from('---\nname: fixture\ndescription: Portable hash fixture\n---\nBody.\n', 'utf8'),
  'B.txt': Buffer.from('upper\n', 'utf8'),
  'a.txt': Buffer.from('lower\n', 'utf8'),
  'a.b': Buffer.from('dot\n', 'utf8'),
  'a/b': Buffer.from('slash\n', 'utf8'),
  'a/z/deep.txt': Buffer.from('deep\n', 'utf8'),
  'crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8'),
  'unicode.txt': Buffer.from('636166c3a920e29c9320e697a5e69cac0a', 'hex'),   // non-ASCII text, as UTF-8 bytes
  'binary.bin': Buffer.from([0, 255, 13, 10, 10, 13, 0, 128]),
  'empty': Buffer.alloc(0),
};

// If this ever has to change, every existing lockfile stops verifying.
const EXPECTED_DIR_HASH = 'sha256:a6f6642fa20e0446591a4f427db13ef4ce58acc53f6ae311627c91bba31dccc0';
const EXPECTED_FILE_HASH = 'sha256:9b9705ef8a78469de01baa18122754e632c8cb87f2020b0c0869ca5d288eaa08';

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'morf-hash-'));
  for (const [rel, buf] of Object.entries(FIXTURE)) {
    const p = join(dir, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
  }
  return dir;
}

test('portable hash of the fixture directory equals the stored constant on every OS', async () => {
  const dir = build();
  try {
    assert.equal(await portableHashPath(dir), EXPECTED_DIR_HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('portable hash of a single file equals the stored constant on every OS', async () => {
  const dir = build();
  try {
    assert.equal(await portableHashPath(join(dir, 'SKILL.md')), EXPECTED_FILE_HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the digest does not depend on input order or on the path separator', () => {
  const entries = Object.entries(FIXTURE).map(([rel, buf]) => ({ rel, buf }));
  const forward = portableDigest(entries);
  const backward = portableDigest([...entries].reverse().map(e => ({ rel: e.rel.replace(/\//g, '\\'), buf: e.buf })));
  assert.equal(forward, EXPECTED_DIR_HASH);
  assert.equal(backward, EXPECTED_DIR_HASH);
});
