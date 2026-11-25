#!/usr/bin/env node
import { run } from '../src/cli.js';
import { printable } from '../src/util/log.js';

run(process.argv).catch(err => {
  // Top-level catch: never print a stack trace for expected errors.
  console.error(`\x1b[31m\u2717\x1b[0m ${printable(err.message)}`);
  process.exit(1);
});
