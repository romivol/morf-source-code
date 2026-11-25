# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

morf (`@romivol/morf`) is a zero-dependency Node.js CLI that installs AI-tool primitives (skills, agents, rules, prompts, hooks, MCP servers) from a git repo into seven tools (claude, opencode, kilo, codex, cursor, copilot, windsurf), converting each to the tool's native format on install. The public description of what it must do is https://morf.tools.

## Commands

```sh
npm install                                # dev deps only (eslint); there are no runtime deps
npm test                                   # node --test (built-in runner, no framework)
node --test test/convert/agents.test.js    # one test file
node --test --test-name-pattern="codex"    # tests whose name matches a pattern
npm run lint                               # eslint . (flat config, ESLint 9)
npm run test:count                         # guard: the runner reports every test each file defines
node bin/cli.js --help                     # run the CLI from source
MORF_NETWORK_TESTS=1 node --test test/repo/network.test.js   # tests that fetch from GitHub (skipped otherwise)
```

CI (`.github/workflows/ci.yml`) runs `npm run lint` then `npm test` on Linux, macOS and Windows with Node 18 and the current LTS, with `MORF_NETWORK_TESTS=1`. Avoid APIs newer than Node 18. `test/util/portable-hash.test.js` holds a hash constant all three systems must reproduce; changing it invalidates every existing lockfile.

Capture output in tests only with `run()` from `test/helpers.js`. Replacing `process.stdout.write` yourself can swallow the frames the test runner sends to its parent, and tests then vanish from the report; `npm run test:count` (also a CI step) exists to catch that. Before pushing, run the suite on Node 18 as well if you can: it has caught a failure the newer Node hid.

### Trying the CLI safely

Running the CLI from source is not sandboxed: it writes to the real `~/.morf/` and to real tool config, including shared files such as `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml` and `~/.config/opencode/opencode.json`. To exercise it, point the home directory at a scratch folder and run from a scratch project directory:

```sh
export HOME=/tmp/morf-home USERPROFILE=/tmp/morf-home   # os.homedir() reads USERPROFILE on Windows
cd /tmp/morf-proj && node /path/to/repo/bin/cli.js install /path/to/a/local/git/repo --target all --ascii
```

A local directory works as the repo argument as long as it is a git repository with a commit. `--dry-run` still clones.

## Architecture

`bin/cli.js` calls `run()` in `src/cli.js` and prints any thrown error as one red line with exit code 1. `src/cli.js` parses argv by hand and dispatches to one module per subcommand in `src/commands/`. `install`, `update` and `uninstall` share `parseInstallArgs`, which returns `{ repoArg, names: { skill: [], agent: [], ... }, all, targets, force, ref, dryRun }`. A bare `morf install <repo>` means `--all`. Install's default target is: `--target` flag, else configured default, else `detectTargets()`, else `opencode`. `update` and `uninstall` with no `--target` act on every target a record exists for.

### The pipeline

`installCommand` → `withTempClone` (`repo/git.js`) → `scanRepo` (`repo/scan.js`) → for each target × item, `installOne` (`install/engine.js`, also used by `update`):

1. `locate(target, type, name)` in `install/store.js` resolves the mapping from `install/targets.js` into a `loc`.
2. `currentHash(loc, record)` hashes what is on disk; a mismatch with the manifest's `installedHash` (or an existing item with no record) is a local change and is skipped unless `--force`.
3. `render(item, loc, config)` converts the source for the target.
4. `write(loc, rendered, record)` stores it and returns the installed hash.
5. The manifest record is updated.

`installOne` returns `{ result, tagName, note }`; the caller counts and prints the row. In dry-run it prints its own lines and returns `tagName: null`.

### Types and source layout (`repo/scan.js`)

`TYPES = ['skill', 'agent', 'rule', 'prompt', 'hook', 'mcp']` drives the CLI flags and selection loops. Sources: `skills/<n>/SKILL.md`, `agents/<n>.md`, `rules/<n>.md|.mdc`, `prompts/<n>.md` (also `commands/`), `hooks/<n>.json`, `mcp/<n>.json`, and a root `.mcp.json`/`mcp.json` map (one item per server). Hook and MCP items carry a parsed `payload`; an unparseable file is returned with `invalid` set so install reports a failed row. The source format for everything is Claude Code's.

### Targets (`install/targets.js`)

One table maps every (target, type) to a storage mapping. Four kinds:

- `dir`: a folder copied to `<base>/<name>/` (skills).
- `file`: one file at `<base>/<prefix><name><ext>`. Optional `register: { file, key }` also lists the file's path in a JSON array (OpenCode/Kilo load rules through `instructions`). Optional `previous: { base, ext }` names where older morf versions put the item, so the stale copy is removed when it moves.
- `json`: merged into a shared JSON file under `path`. `mode: 'entry'` is one object keyed by item name (MCP servers); `mode: 'hooks'` appends anonymous entries to per-event arrays.
- `block`: a marker-delimited block in a shared text file (`style: 'toml'` for Codex `config.toml`, `'md'` for Codex `AGENTS.md`).

`TARGETS` is a snapshot built at import time from `process.cwd()` and from which config files exist (`pickExisting`). Pass `cwd` to `resolveDestination`/`getTargets`/`detectTargets` for another directory. Windsurf resolves to `.devin/` unless the project has only a legacy `.windsurf/` (then agents are rules, `asRule: true`); hooks and MCP always use `.devin/`, and their presence must not flip the legacy check.

Adding a target or changing a path touches: the `install/targets.js` table, the converters (`convert/agents.js`, `rules.js`, `prompts.js`, `hooks.js`, `mcp.js`), the README tables, and `test/install/targets.test.js` (asserts 7 targets).

### Conversion

- `convert/frontmatter.js`: line-based helpers (`getScalar`, `getList`, `getMap`, `setField`, `removeField`, `commentField`, `commentFieldsExcept`). There is no YAML library and adding one would break the no-dependency rule.
- `convert/agents.js` `adaptAgentForTarget(text, target, { name, asRule })`: Claude ↔ OpenCode/Kilo tools map, Cursor subagent (`readonly`), Copilot tool aliases, Devin `allowed-tools`, Codex TOML.
- `convert/rules.js`, `prompts.js`, `hooks.js`, `mcp.js`: `convertRule`, `convertPrompt` return `{ text, notes }`; `convertHook` and `convertMcp` return `{ value, notes }` for JSON merges or `{ text, notes }` for files/blocks; `convertHook` may return `{ unsupported }`. For OpenCode/Kilo a hook becomes generated plugin source with exactly one named export (the plugin loader calls every export).

Unsupported fields are commented out in place with a `(commented by morf: <reason>)` suffix, never deleted. `notes` become the `adapted for <target>: ...` text on the row. `adaptAgentForTarget` falls back to the unchanged input on any parse failure. `morf config convert off` only disables agent frontmatter conversion; the other primitives must convert to be valid.

Bump `CONVERTER_VERSION` in `install/engine.js` whenever converter output changes: records with an older `conv` are re-rendered on the next install/update even when the source hash is unchanged.

### Shared config files (`install/store.js`, `install/json-file.js`)

morf only adds and removes its own entries. Rules that must hold:

- Never overwrite a file that fails to parse: `readJsonFile` throws and the item fails.
- Shared JSON(C) files are edited as text by `install/json-edit.js` (`setPath`, `removePath`, `arrayAppend`, `arrayRemove`), which splices only the affected span. Comments, key order, spacing and line endings of everything else are preserved, and add-then-remove restores the original bytes. Never parse → modify → `JSON.stringify` a file the user owns.
- Marker blocks (`AGENTS.md`, `config.toml`) touch only the lines between morf's begin/end markers. A file with no final newline must not gain one.
- Global mode only: `locate` sets `loc.backup` for a shared file under the home directory, and the store saves `<file>.morf-backup` once before the first real change. Project mode never backs up.
- Merged hooks are anonymous, so the installed value is stored as `payload` on the manifest record and matched by deep equality for hashing and removal.
- A TOML table that already exists outside morf's markers is never duplicated: the write fails with a message.
- All writes are temp-file-then-rename.

### Project mode (`project/`, and `commands/init.js`, `sync.js`, `project-install.js`, `project-uninstall.js`)

Three names, used in every user-visible string: the **project file** (`morf.json`), the **lockfile** (`morf.lock.json`), the **install record** (`~/.morf/installed.json`). Never write "manifest" in anything a user sees; the module is still `install/install-record.js` internally.

`cli.js` calls `findProjectRoot(cwd)`; with a root (and no `--global`) `install`, `update`, `uninstall` and `sync` go to the project-mode command modules. Those functions take `(args, ctx)` with `ctx = { root, cwd, io, morfVersion }`, return an exit code, and never call `process.exit`, so tests drive them directly with a fake `io` (`test/helpers.js`).

- **Scope.** `{ project: root }` is passed to `locate`/`prepare`/`commit`; `tableFor(scope)` picks `getProjectTargets(root)`, where all seven tools have project-level paths. `null` scope is the global behaviour and must stay exactly as it was.
- **Plan then apply.** `prepare(item, options)` classifies without writing (`unsupported`, `modified`, `current`, `adopt`, `install`, `replace`); `commit(prep, options)` writes and updates the record. `installOne` (global) is `prepare` + `commit`. Project commands build actions from `prepare`, print them with `printPlan`, pass them through `approve`, then `commit`.
- **Approval.** `approve(actions, flags, io)` is the only gate. Interactive: one question, plus a second for hooks/MCP. Non-interactive (no TTY, `CI`, or `--frozen`): needs `flags.yes`, and `flags.allowExec` if the plan has a hook or MCP server. The flags come only from argv; never add a config key, file field or env var for them (a test enforces this).
- **Lockfile hashes** are `lockHashOf(item)`: `portableHashPath` (forward slashes, byte-order sort) over a raw checkout from `openClone`, which disables every checkout-time conversion via `.git/info/attributes`. Global mode keeps `hashPath`/`withTempClone`; do not mix the two.
- **Sync** (`syncCommand`, also `update` via `flags.update`): validate every source (fetch pinned commit, compare hashes) before anything else; any failure returns 1 with nothing changed. New items in an already-locked source resolve at the pinned commit.
- **Shared destinations** (`mapping.shared`): each owning tool has its own record carrying `physical`; `removeInstalled` deletes from disk only when no co-owner record is left. A shared `.mcp.json` entry is rendered in the Copilot shape for every owner.
- **Adoption.** In project mode an item on disk with no record, identical to what morf would write (`matchesRendered`), is treated as installed. This is what makes committed tool files work on a fresh clone.
- `project/project-file-and-lockfile.js` writes both files through `stableStringify` (sorted, compact one-line leaf objects) and only when bytes change. `writeLockfile` ignores `morfVersion` when deciding whether anything changed.

`docs/unverified.md` lists every path and behaviour not yet checked in a real tool. Add to it when implementing from documentation alone, and move entries to its "Verified" table when confirmed.

### State (`~/.morf/`)

- `installed.json` (`install/install-record.js`): version 3, items keyed `type:name:target` for global installs and `type:name:target@<projectRoot>` for project installs. Records hold `project` (`''` when global), `sourceHash` (source repo copy, or the payload for hook/MCP; the lockfile hash in project mode), `installedHash` (what was written after conversion), `conv`, and optionally `payload` and `physical`. Read hashes through `getInstalledHash`/`getSourceHash`, which fall back to the legacy `hash` field. Use `recordsFor(manifest, project)`; the global commands must only ever see `recordsFor(manifest, '')`.
- `config.json` (`util/config.js`): default target, default repo, `@alias` map, `convertTools`.

A corrupt manifest is renamed to `.bak.<timestamp>` and replaced. v1 manifests and the legacy `~/.ray/` directory are migrated on read. `repo/url.js` `normalizeRepo` produces the `repoKey` used to treat different URL spellings as the same repo.

### Untrusted input (`repo/validate.js`, `util/log.js` `printable`)

A repo, ref, commit, item name, hook command or MCP command can come from a file someone else wrote (`morf.json`, `morf.lock.json`, a source repository), from the command line, the config file or the install record. Two rules, each with tests in `test/project/security.test.js` and `terminal-output.test.js`:

- **Nothing reaches git unvalidated.** `assertSafeRepo`, `assertSafeRef`, `assertSafeCommit` and `assertSafeItemName` run when the project files are read, in `resolveRepo`, and again inside `repo/git.js` before any spawn. `repo/git.js` is the only module that may import `child_process`; every call goes through `runGit`, puts `--` / `--end-of-options` before values, uses `--branch=<ref>`, and sets `GIT_ALLOW_PROTOCOL`. A command must validate before `assertGitAvailable()`, which itself starts git.
- **Links and submodules are refused.** Scan a checkout with `scanClone` (never `scanRepo` directly on a clone): it marks any item that is or contains a link (mode 120000) or submodule (160000) `invalid`. Every git call runs with `core.symlinks=false`. `portableHashPath`, `hashPath(..., { strict: true })` and `copyDir` throw on anything that is not a regular file or directory.
- **Names are checked where paths are built.** `locate` throws unless the name is exactly what `sanitizeName` produces, so a name from the install record is as constrained as one from a repository. `assertNoMarker` refuses block text containing morf's own markers.
- **Every checkout is raw**, in global mode too (`cloneTemp` and `openClone` both clone with `--no-checkout`, write `.git/info/attributes`, then check out), so a repository's `.gitattributes` cannot trigger a filter from the user's git config.
- **Upgrades do not rewrite unchanged items.** `prepare` returns `adopt` when an installed, unedited item matches what morf would write apart from line endings (`matchesRendered(..., { ignoreLineEndings: true })`); only the record is refreshed. This is what keeps a 1.1.2 install on Windows (CRLF files) untouched. Do not remove it without re-running `test/commands/upgrade-from-1.1.2.test.js`.
- **Nothing is dropped silently.** An item whose name cannot be sanitized is returned by the scanner with `invalid` set.
- **Hooks and MCP servers always need approval.** Project mode: `approve`. Global mode: `approveExec` in `commands/install.js` and `update.js`.
- **Nothing untrusted is printed raw.** Pass such values through `printable` (the `t` tag in `util/messages.js` does it for message templates; `createTargetTable` and `printPlan` do it for their cells). `gitCalls` records arguments only, never the environment, because a failing assertion would print it.

### Output

All terminal output goes through `util/log.js`; `util/table.js` renders the `TARGET / NAME / STATUS` tables, streaming rows as items finish (rationale in `docs/design/table-output.md`). Symbols switch to ASCII tokens with `--ascii`, `MORF_ASCII=1`, or automatically when stdout is not a TTY, so piped output differs from a terminal. Color is off when not a TTY or when `NO_COLOR` is set.

## Conventions

- ES modules throughout; import built-ins with the `node:` prefix.
- No runtime dependencies. The published package must stay standard-library only.
- User-facing strings belong in `src/util/messages.js`.
- Expected errors produce a one-line message and a non-zero exit code, never a stack trace. Command modules call `process.exit(1)` after printing a summary when anything failed.
- Two-space indent, single quotes, semicolons, LF line endings (`.editorconfig`). The checkout may have CRLF working files under `core.autocrlf`; that is not a content change.
- Tests live in `test/<folder>/<unit>.test.js`, mirroring `src/`; `test/helpers.js` holds the sandbox, fixture repos and `projectKit`. Converters are tested as pure functions; `test/install/store.test.js` builds `loc` objects by hand against a temp directory so nothing touches the real home directory.
- Tool formats change often. Before changing a path or field for a tool, check that tool's current documentation rather than relying on memory.
