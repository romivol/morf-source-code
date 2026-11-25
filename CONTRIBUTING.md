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
src/
  cli.js          argument parsing + command dispatch
  commands/       one file per command: install, update, uninstall, list, config
                  (global mode); init, sync, project-install, project-uninstall
  convert/        text conversion, one module per primitive: agents, rules,
                  prompts, hooks, mcp; plus frontmatter helpers (no YAML library)
  install/        targets (per-tool storage tables), engine (prepare/commit one
                  item), store (files and merged config), json-edit (in-place edits
                  to shared JSON(C) files), json-file, install-record
  project/        project-file-and-lockfile (morf.json, morf.lock.json), plan,
                  approve (the approval gate: --yes, --allow-exec)
  repo/           git (clone, exact-commit fetch), url (repo URLs), scan
  util/           fs, sanitize, log, table, messages (all user-facing strings),
                  banner, config (~/.morf/config.json)
test/           node --test suites, mirroring src/
docs/design/    design notes and specs
```

## Conventions

- **ES modules** throughout (`"type": "module"`); use `node:` import specifiers
  for built-ins.
- **No runtime dependencies.** The published package must stay dependency-free;
  keep new code within the standard library.
- **User-facing text lives in `src/util/messages.js`.** Don't hard-code strings in
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

`npm run test:count` runs every test file twice, once through the runner and
once directly, and fails if the two report a different number of tests. CI runs
it after the suite. It exists because a test that captures `process.stdout` can
swallow the runner's own result frames, which makes tests disappear from the
report without failing; use the `run` helper in `test/helpers.js` to capture
output, never your own replacement of `process.stdout.write`.

Prefer unit tests over the pure modules (`convert`, `sanitize`, `source`,
`messages`), which are deterministic and side-effect free. When adding a
feature, add a matching `test/<folder>/<unit>.test.js`.

## Submitting changes

1. Create a branch off `main`.
2. Make your change with tests and a green `npm run lint && npm test`.
3. Open a pull request describing the change and its motivation.
