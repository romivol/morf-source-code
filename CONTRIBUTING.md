# Contributing to morf

Thanks for your interest in improving morf! This document covers the basics of
getting set up and the conventions the project follows.

## Prerequisites

- **Node.js >= 18** (uses the built-in test runner and modern `fs` APIs)
- **git** on your `PATH` (morf shells out to `git clone`; it is not bundled)

## Getting started

```bash
git clone https://github.com/PLACEHOLDER/morf.git
cd morf
npm install
npm test        # run the test suite (node --test)
npm run lint    # run ESLint
node bin/cli.js --help   # run the CLI from source
```

## Project layout

```
bin/            CLI entry point (thin wrapper around src/cli.js)
src/            Library code
  cli.js          argument parsing + command dispatch
  commands/       one file per subcommand (install/update/uninstall/list/config)
  convert.js      agent frontmatter/tool-format conversion per target
  targets.js      per-tool install-location table (claude, cursor, ...)
  git.js          clone + error classification
  manifest.js     ~/.morf/installed.json read/write + migrations
  config.js       ~/.morf/config.json read/write
  fsops.js        filesystem + hashing helpers
  sanitize.js     untrusted-name sanitization + path-traversal guards
  scan.js         discover skills/agents in a repo or on disk
  source.js       repo-URL normalization
  messages.js     all user-facing strings
  log.js          colored/ASCII terminal output + spinner
test/           node --test suites (mirror src/ by unit)
```

## Conventions

- **ES modules** throughout (`"type": "module"`); use `node:` import specifiers
  for built-ins.
- **No runtime dependencies.** The published package must stay dependency-free;
  keep new code within the standard library.
- **User-facing text lives in `src/messages.js`.** Don't hard-code strings in
  command modules.
- **Fail friendly.** Expected errors surface a one-line message (no stack
  traces) and a non-zero exit code. Parsing/IO helpers degrade gracefully rather
  than throwing on malformed input.
- **Two-space indentation, single quotes, semicolons** (enforced by ESLint /
  `.editorconfig`).

## Tests

Tests use Node's built-in runner — no framework to install:

```bash
npm test
```

Prefer unit tests over the pure modules (`convert`, `sanitize`, `source`,
`messages`), which are deterministic and side-effect free. When adding a
feature, add a matching `test/<unit>.test.js`.

## Submitting changes

1. Create a branch off `main`.
2. Make your change with tests and a green `npm run lint && npm test`.
3. Open a pull request describing the change and its motivation.
