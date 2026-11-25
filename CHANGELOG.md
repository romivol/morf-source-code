# Changelog

## Unreleased

### Added

- **Project file and lockfile.** `morf init` creates `morf.json` (the project file). Installing inside a project records what was asked for in `morf.json` and what it resolved to in `morf.lock.json` (the lockfile): the exact commit of each repo and a content hash of each item. Both files are meant to be committed and contain no machine-specific data.
- **`morf sync`** makes a project match its lockfile. `--frozen` never writes the project file or lockfile and fails on any mismatch (the default when `CI` is set). `--check` is read-only and exits 1 on drift, reporting lockfile-vs-project-file and lockfile-vs-disk separately. `--prune` removes installed items that are no longer in the lockfile.
- **Project mode.** With a `morf.json` in the current or a parent directory, every tool installs into its project-level directory; nothing is written under the home directory. Claude Code, OpenCode, Kilo and Codex gained project-level destinations. `--global` forces the global behaviour and leaves the project files alone.
- **Approval.** In a project, `install`, `update`, `uninstall` and `sync` print a plan and ask before changing anything (default No), with a second question for hooks and MCP servers. In CI, with `--frozen`, or without a terminal, nothing is applied without `--yes`, and hooks and MCP servers additionally need `--allow-exec`. Removing a hook or MCP server never needs `--allow-exec`. Neither flag is ever read from a file or the environment.
- **Rules, prompts, hooks and MCP servers** as installable items alongside skills and agents, for all seven tools (`--rule`, `--prompt`, `--hook`, `--mcp`).
- **Zero-flag install.** `morf install <repo>` installs everything in the repo into every detected tool. `morf list --all` is an alias for `--all-on-disk`.
- **Shared ownership.** Where two tools read the same destination (`.agents/skills/` for Codex and Copilot, `.mcp.json` for Claude Code and Copilot), the item is written once and removed only when no tool owns it any more.
- **Portable content hashes.** In project mode morf checks out the exact bytes git stores (line-ending conversion off) and hashes with forward-slash paths in byte order, so a lockfile verifies on every OS.
- **`--dry-run` in a project** prints the plan and stops: no questions and no changes, whatever the other flags say.
- **CI** runs lint and the full suite on Linux, macOS and Windows, on Node 18 and the current LTS, including a cross-system check of the lockfile hash and a fetch-by-commit test against a real remote.
- **Size warning.** An item whose files total more than 5 MB is pointed out with its size, in the plan in project mode and on its row in global mode. There is no size limit.
- **Skipped hooks and MCP servers are named in the summary**, with the reason: you declined, or `--allow-exec` was not given.
- **`npm run test:count`**, run in CI, fails if the test runner reports fewer tests than the test files define.
- **Exact commits.** `sync` fetches the pinned commit by SHA, falling back to a full clone when the host refuses, and never substitutes another commit.

### Security

- **A repo or ref can no longer reach git as an option or a remote helper.** A `repo` in `morf.json` or `morf.lock.json` starting with `-` (for example `--upload-pack=<command>`) was passed to git unchecked and ran that command during `morf sync`, before the plan was shown and even with `--dry-run`. Fixed in layers:
  - The project file and the lockfile are rejected on read unless every repo is an `https://` or `ssh://` URL, a `user@host:path` address or a relative path starting with `./` or `../`; refs and item names are validated too. The same check applies to the command line, the config file's default repo and aliases, and repos read from the install record.
  - Every git invocation puts `--` or `--end-of-options` before values, and passes a branch as `--branch=<ref>`.
  - `GIT_ALLOW_PROTOCOL` restricts git to https, ssh and local files, so helpers such as `ext::` are refused by git itself.
  - No git process starts before validation has passed.
  - `http://` and `git://` repository URLs are no longer accepted.
- **Hooks and MCP servers are never installed silently, in or out of a project.** Outside a project, `morf install` and `morf update` used to install them like any other item, so a bare `morf install <repo>` could put a command-running hook into your tool config without asking. They are now listed with the command each will run and need a yes (default No); with no terminal or in CI they need `--allow-exec`, and without it they are skipped and the command exits 1. Removal never needs the flag.
- **Untrusted text is escaped before it is printed.** Repo, ref, item names, hook and MCP commands, and git's own error text are shown with control characters (ESC, CR, backspace, newlines) and bidirectional-override characters made visible, so they cannot hide or rewrite the plan a user is asked to approve.
- Validation errors no longer repeat credentials found in a repository URL.
- **Symbolic links and submodules in a source repository are refused.** A link inside a skill used to be copied as a link and was not part of the content hash. An item that is a link or a submodule, or contains one, now fails with a message naming it, and nothing from it is installed. morf's own checkouts never create a link on disk.
- **Text containing morf's own block markers is refused.** A rule written into `AGENTS.md` could contain an end marker and leave text behind when removed.
- **Names from the install record are checked before they are used in a path.** A hand-edited record can no longer address another item.
- `morf config list` escapes the values it reads from the config file.
- **A repository's `.gitattributes` can no longer trigger a git filter outside a project.** Global mode made an ordinary checkout, so a repository could name any filter configured in your git (git-lfs, for example) and git ran it during the clone. Global mode now makes the same raw checkout as project mode.

### Behaviour changes

- **Upgrading from 1.1.2 does not rewrite items that have not changed.** 1.1.2 installed whatever an ordinary git checkout produced, which on Windows with `core.autocrlf` means CRLF files. morf now checks out the exact bytes git stores. An installed item you have not edited, whose content differs from the source only in line endings, is left exactly as it is and reported up to date; only the install record is refreshed. Nothing is reported as locally edited because of the upgrade. An item whose converted output really changed (agents for OpenCode, Kilo, Cursor, Copilot, Windsurf and Codex, whose formats were corrected) is updated on the next `morf update`.
- **An item whose name cannot be made into a safe file name is reported as a failure**, by its original name, instead of being skipped silently. In a project this stops the command before anything is changed.

- **`http://` and `git://` repository URLs are rejected**, on the command line as well as in the project files. Both are unencrypted and unauthenticated, so anyone on the network path can replace what is fetched; and keeping the list of transports as short as possible (`https`, `ssh`, local files) is what lets git itself refuse helper transports such as `ext::`. Use the `https://` or `ssh://` address of the same repository.
- **Outside a project, hooks and MCP servers now need a yes, or `--allow-exec` when there is no terminal.** A script that runs `morf install` unattended and relies on hooks or MCP servers being installed must add `--allow-exec`.
- **A source repository containing symbolic links or submodules** no longer installs the items that contain them.

### Changed

- **Shared config files are edited in place.** In `settings.json`, `.mcp.json`, `opencode.json`, `kilo.jsonc`, `AGENTS.md`, `config.toml` and the other files morf shares with you, only morf's own entries change. Comments, key order and spacing are preserved, and removing an entry restores the file as it was. A file that cannot be parsed is reported and left untouched. Outside a project, the original of a file under the home directory is saved once as `<file>.morf-backup` before morf first changes it.
- **The install record gained a project field.** Existing records are migrated on first run and treated as global installs. The same item can be installed globally and in several projects without one overwriting another.
- **`uninstall` and `update` without `--target`** act on every tool the item is installed in.
- **Native agent formats.** Cursor agents are written as subagents in `.cursor/agents/`, Windsurf (Devin) agents in `.devin/agents/`, and Codex agents as TOML in `~/.codex/agents/`. Copilot agents get their tools mapped to Copilot's aliases.
- **Wording.** `~/.morf/installed.json` is now called the "install record" everywhere a user can see it.

### Fixed

- **Uninstall no longer leaves empty directories behind.** When morf has to create a directory to hold an item (for example `~/.claude/rules/`), it notes that in the install record, and removes the directory again when the last item in it is uninstalled. A directory that existed before, or that still holds anything else, is never removed.
- **A remote MCP server installed in a project is now seen by Claude Code.** The entry in the shared `.mcp.json` carried `"tools": ["*"]`, and Claude Code silently ignores a remote (`http` or `sse`) entry with that key. morf now writes `tools` on local entries only; Copilot defaults to all tools without it. Existing entries are rewritten on the next `morf sync` or `morf install`.
- **`morf uninstall <repo>` ignored the repository.** The argument was accepted and dropped, so `morf uninstall <repo> --all` removed everything morf manages. It now removes only what was installed from that repository, in global and project mode, and exits 1 without removing anything when nothing came from it.

- A checkout that fails because the system cannot create one of the repository's paths (a name that is not allowed, or too long) now names the path and says that nothing from that repository was installed.

- `github.com/owner/repo` (no scheme) was handed to git unchanged and read as a local path. It is now expanded to `https://github.com/owner/repo` when it has that shape and no local directory of that name exists.
- `permission` in OpenCode and Kilo agent frontmatter was commented out as unsupported; it is valid and is now kept.
- A Windsurf project with only a legacy `.windsurf/` directory no longer flips to `.devin/` just because morf wrote hooks or MCP config there.

### Not in this version

- A user-level lockfile, the registry, short-name installs and `morf publish`.
