import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortRepo } from '../src/commands/list.js';

test('shortRepo shortens an HTTPS URL to owner/repo', () => {
  assert.equal(shortRepo('https://github.com/Foo/Bar.git'), 'Foo/Bar');
});

test('shortRepo shortens an SCP-style SSH remote', () => {
  assert.equal(shortRepo('git@github.com:Foo/Bar.git'), 'Foo/Bar');
});

test('shortRepo strips the host from a normalized repoKey', () => {
  assert.equal(shortRepo('github.com/foo/bar'), 'foo/bar');
});

test('shortRepo returns empty string for falsy input', () => {
  assert.equal(shortRepo(''), '');
  assert.equal(shortRepo(null), '');
});
