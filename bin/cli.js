#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv).catch(err => {
  // Top-level catch: never print a stack trace for expected errors.
  console.error(`\x1b[31m\u2717\x1b[0m ${err.message}`);
  process.exit(1);
});
