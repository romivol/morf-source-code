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
- **Exact commits.** `sync` fetches the pinned commit by SHA, falling back to a full clone when the host refuses, and never substitutes another commit.

### Changed

- **Shared config files are edited in place.** In `settings.json`, `.mcp.json`, `opencode.json`, `kilo.jsonc`, `AGENTS.md`, `config.toml` and the other files morf shares with you, only morf's own entries change. Comments, key order and spacing are preserved, and removing an entry restores the file as it was. A file that cannot be parsed is reported and left untouched. Outside a project, the original of a file under the home directory is saved once as `<file>.morf-backup` before morf first changes it.
- **The install record gained a project field.** Existing records are migrated on first run and treated as global installs. The same item can be installed globally and in several projects without one overwriting another.
- **`uninstall` and `update` without `--target`** act on every tool the item is installed in.
- **Native agent formats.** Cursor agents are written as subagents in `.cursor/agents/`, Windsurf (Devin) agents in `.devin/agents/`, and Codex agents as TOML in `~/.codex/agents/`. Copilot agents get their tools mapped to Copilot's aliases.
- **Wording.** `~/.morf/installed.json` is now called the "install record" everywhere a user can see it.

### Fixed

- `github.com/owner/repo` (no scheme) was handed to git unchanged and read as a local path. It is now expanded to `https://github.com/owner/repo` when it has that shape and no local directory of that name exists.
- `permission` in OpenCode and Kilo agent frontmatter was commented out as unsupported; it is valid and is now kept.
- A Windsurf project with only a legacy `.windsurf/` directory no longer flips to `.devin/` just because morf wrote hooks or MCP config there.

### Not in this version

- A user-level lockfile, the registry, short-name installs and `morf publish`.
