// Network tests: fetch a pinned commit from a real remote.
//
// They need internet access, so they are skipped unless MORF_NETWORK_TESTS=1.
// CI sets it; a plain `npm test` stays offline.
//
//   MORF_NETWORK_TESTS=1 node --test test/network.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openClone } from '../src/git.js';
import { portableHashPath } from '../src/fsops.js';

const skip = process.env.MORF_NETWORK_TESTS ? false : 'set MORF_NETWORK_TESTS=1 to run network tests';

// github.com/octocat/Hello-World: tiny, public, and unchanged for years.
const REPO = 'https://github.com/octocat/Hello-World.git';
const TIP = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';      // master
const OLDER = '553c2077f0edc3d5dc5d17262f6aa498e69d6f8e';    // an earlier commit, not a branch tip
const README_AT_OLDER = 'Hello World!';                      // the file has no final newline

async function checkout(options) {
  const clone = await openClone(REPO, options);
  try {
    return {
      via: clone.via,
      commit: clone.commit,
      readme: readFileSync(join(clone.dir, 'README'), 'utf8'),
      hash: await portableHashPath(join(clone.dir, 'README')),
      hasGit: existsSync(join(clone.dir, '.git')),
    };
  } finally {
    await clone.close();
  }
}

test('fetches exactly the pinned commit from GitHub, by SHA', { skip }, async () => {
  const got = await checkout({ commit: OLDER });
  assert.equal(got.commit, OLDER);
  assert.equal(got.via, 'fetch', 'GitHub serves a commit asked for by SHA');
  assert.equal(got.readme, README_AT_OLDER);
});

test('the full-clone fallback reaches the same commit and the same bytes', { skip }, async () => {
  const direct = await checkout({ commit: OLDER });
  const fallback = await checkout({ commit: OLDER, fullClone: true });
  assert.equal(fallback.via, 'clone');
  assert.equal(fallback.commit, OLDER);
  assert.equal(fallback.readme, direct.readme);
  assert.equal(fallback.hash, direct.hash);
});

test('a branch tip resolves to its commit, and the tip can then be pinned', { skip }, async () => {
  const tip = await checkout({ ref: 'master' });
  assert.equal(tip.commit, TIP);
  const pinned = await checkout({ commit: TIP });
  assert.equal(pinned.hash, tip.hash);
});

test('a commit that does not exist is refused, never replaced by another', { skip }, async () => {
  await assert.rejects(() => openClone(REPO, { commit: 'd'.repeat(40) }), /could not be fetched/);
});

test('host/path shorthand reaches the same repository', { skip }, async () => {
  const clone = await openClone('github.com/octocat/Hello-World', { commit: TIP });
  try {
    assert.equal(clone.commit, TIP);
  } finally {
    await clone.close();
  }
});
