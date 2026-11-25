import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPath, removePath, arrayAppend, arrayRemove, getPath } from '../../src/install/json-edit.js';

test('jsonedit: edits round-trip on awkward inputs', () => {
  const cases = [
    '{}',
    '{\n}\n',
    '{ "a": 1 }',
    '{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n',
    '{\n  "a": [\n    1, // one\n    2\n  ]\n}\n',
    '{\n  "s": "a \\"quoted\\" // not a comment, { not a brace }",\n  "t": 2\n}\n',
  ];
  for (const original of cases) {
    const added = setPath(original, ['x', 'y'], { z: [1, { w: 'v' }] });
    assert.deepEqual(getPath(added, ['x', 'y']), { z: [1, { w: 'v' }] });
    // An object that was empty has no layout to restore; anything else comes
    // back exactly.
    const removed = removePath(added, ['x']);
    if (/^\{\s*\}\s*$/.test(original)) assert.deepEqual(getPath(removed, []), {});
    else assert.equal(removed, original);
    const arr = arrayAppend(arrayAppend(original, ['list'], 'p'), ['list'], 'q');
    assert.deepEqual(getPath(arr, ['list']), ['p', 'q']);
    assert.equal(arrayAppend(arr, ['list'], 'p'), arr, 'no duplicates');
    assert.deepEqual(getPath(arrayRemove(arr, ['list'], 'p'), ['list']), ['q']);
    assert.deepEqual(getPath(arrayRemove(arrayRemove(arr, ['list'], 'q'), ['list'], 'p'), ['list']), []);
  }
  // Replacing a value keeps the neighbours and their comments.
  const doc = '{\n  "keep": 1, // note\n  "x": { "old": true },\n  "after": 2\n}\n';
  const replaced = setPath(doc, ['x'], { new: 1 });
  assert.match(replaced, /"keep": 1, \/\/ note/);
  assert.match(replaced, /"after": 2/);
  assert.deepEqual(getPath(replaced, ['x']), { new: 1 });
});
