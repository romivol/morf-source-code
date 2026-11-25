import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSummary } from '../../src/util/messages.js';

test('installSummary returns null when nothing happened', () => {
  assert.equal(installSummary({}), null);
  assert.equal(installSummary({ installed: 0, failed: 0 }), null);
});

test('installSummary capitalizes the first clause and ends with a period', () => {
  assert.equal(installSummary({ installed: 2 }), 'Installed 2.');
});

test('installSummary joins multiple clauses and annotates skipped', () => {
  assert.equal(
    installSummary({ installed: 1, skipped: 3 }),
    'Installed 1, skipped 3 (locally modified).',
  );
});
