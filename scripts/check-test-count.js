// Guard: the test runner must report every test that is defined.
//
// `node --test` runs each test file in a child process, and the child sends
// its results to the parent as binary frames on its own stdout. A test that
// replaces process.stdout.write to capture output can swallow those frames,
// and the affected tests then vanish from the report without failing anything.
// That happened once in this repository.
//
// This script runs every test file twice and compares:
//   - through the runner (`node --test <file>`), which depends on those frames;
//   - directly (`node <file>`), where the count is kept inside the one process.
// If the two disagree for any file, tests are going missing, and it exits 1.
//
//   node scripts/check-test-count.js

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));

function testFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out.sort();
}

// Run node with the TAP reporter and read its "# tests N" summary line.
function count(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test-reporter=tap', ...args], { cwd: root, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      const read = name => { const m = out.match(new RegExp(`^# ${name} (\\d+)$`, 'm')); return m ? Number(m[1]) : null; };
      resolve({ code, tests: read('tests'), fail: read('fail') });
    });
  });
}

const files = testFiles(join(root, 'test'));
const queue = [...files];
const rows = [];
async function worker() {
  for (let file = queue.shift(); file; file = queue.shift()) {
    const rel = relative(root, file).split('\\').join('/');
    const [viaRunner, direct] = await Promise.all([count(['--test', file]), count([file])]);
    rows.push({ rel, viaRunner, direct });
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.min(4, cpus().length)) }, worker));
rows.sort((a, b) => a.rel.localeCompare(b.rel));

let bad = 0;
let total = 0;
for (const { rel, viaRunner, direct } of rows) {
  const ok = viaRunner.tests !== null && viaRunner.tests === direct.tests && direct.tests > 0;
  total += direct.tests || 0;
  if (!ok) {
    bad++;
    console.log(`MISMATCH  ${rel}: the runner reports ${viaRunner.tests} tests, the file defines ${direct.tests}`);
  }
}
if (bad > 0) {
  console.log(`\n${bad} of ${rows.length} test files report a different number of tests than they define.`);
  console.log('A test is probably swallowing the runner\'s output (see the note at the top of this script).');
  process.exit(1);
}
console.log(`ok: ${rows.length} test files, ${total} tests, and the runner reports every one of them.`);
