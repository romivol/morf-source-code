import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sanitizeName, assertPathInside } from '../../src/util/sanitize.js';

test('sanitizeName lowercases and dashes unsafe characters', () => {
  assert.equal(sanitizeName('PDF Skill'), 'pdf-skill');
  assert.equal(sanitizeName('My_Cool.Agent'), 'my_cool.agent');
});

test('sanitizeName strips leading/trailing dots and dashes (blocks hidden/.. names)', () => {
  assert.equal(sanitizeName('..evil'), 'evil');
  assert.equal(sanitizeName('--weird--'), 'weird');
});

test('sanitizeName throws when nothing safe remains', () => {
  assert.throws(() => sanitizeName('---'));
  assert.throws(() => sanitizeName('...'));
  assert.throws(() => sanitizeName(42));
});

test('assertPathInside allows children of base', () => {
  const base = join(process.cwd(), 'base');
  assert.doesNotThrow(() => assertPathInside(base, join(base, 'child')));
});

test('assertPathInside rejects traversal outside base', () => {
  const base = join(process.cwd(), 'base');
  assert.throws(() => assertPathInside(base, join(base, '..', 'escape')));
});
