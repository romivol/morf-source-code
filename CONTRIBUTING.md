# Contributing to morf

Thanks for your interest in improving morf! This document covers the basics of
getting set up and the conventions the project follows.

## Prerequisites

- **Node.js >= 18** (uses the built-in test runner and modern `fs` APIs)
- **git** on your `PATH` (morf shells out to `git clone`; it is not bundled)

## Getting started

```bash
git clone https://github.com/romivol/morf-source-code.git
cd morf-source-code
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
  targets.js      per-tool storage table (where and how each primitive is stored)
  scan.js         discover skills/agents/rules/prompts/hooks/MCP servers in a repo
  convert.js      agent conversion per target
  primitives.js   rule, prompt, hook and MCP-server conversion per target
  frontmatter.js  line-based frontmatter helpers (no YAML library)
  store.js        read/write/remove an installed item: files and merged config
  jsonfile.js     tolerant JSON(C) reading, atomic writes, canonical hashing
  jsonedit.js     in-place edits to shared JSON(C) files (every other byte preserved)
  project.js      the project file (morf.json) and the lockfile (morf.lock.json)
  approve.js      the plan and the approval gate (--yes, --allow-exec)
  git.js          clone + error classification
  manifest.js     the install record (~/.morf/installed.json): read/write + migrations
  config.js       ~/.morf/config.json read/write
  fsops.js        filesystem + hashing helpers
  sanitize.js     untrusted-name sanitization + path-traversal guards
  source.js       repo-URL normalization
  table.js        aligned terminal table rendering
  messages.js     all user-facing strings
  log.js          colored/ASCII terminal output + spinner
test/           node --test suites (mirror src/ by unit)
docs/design/    design notes and specs
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
