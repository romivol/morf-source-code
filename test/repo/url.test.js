import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepo } from '../../src/repo/url.js';

test('normalizeRepo strips scheme, .git suffix and lowercases the host', () => {
  assert.equal(normalizeRepo('https://GitHub.com/Foo/Bar.git'), 'github.com/Foo/Bar');
});

test('normalizeRepo canonicalizes SCP-style SSH remotes', () => {
  assert.equal(normalizeRepo('git@github.com:Foo/Bar.git'), 'github.com/Foo/Bar');
});

test('normalizeRepo handles host/path shorthand', () => {
  assert.equal(normalizeRepo('github.com/Foo/Bar'), 'github.com/Foo/Bar');
});

test('normalizeRepo strips port and userinfo from URLs', () => {
  assert.equal(normalizeRepo('ssh://git@example.com:2222/Foo/Bar.git'), 'example.com/Foo/Bar');
});

test('normalizeRepo leaves local paths untouched', () => {
  assert.equal(normalizeRepo('/home/me/repo'), '/home/me/repo');
});

test('normalizeRepo treats format differences of the same repo as equal', () => {
  assert.equal(
    normalizeRepo('https://github.com/a/b.git'),
    normalizeRepo('git@github.com:a/b.git'),
  );
});
