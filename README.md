# morf

[![npm version](https://img.shields.io/npm/v/%40romivol%2Fmorf.svg)](https://www.npmjs.com/package/@romivol/morf)
[![CI](https://github.com/romivol/morf-source-code/actions/workflows/ci.yml/badge.svg)](https://github.com/romivol/morf-source-code/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**One agent, every tool.**

morf is a command-line package manager for AI coding tools. It installs skills, agents, rules, prompts, hooks and MCP servers from any git repository into the tools you use, and converts each one into that tool's native format instead of copying the file as-is.

Website: [morf.tools](https://morf.tools)

```
$ morf install github.com/acme/agents --agent bug-finder --target all

  TARGET      NAME          STATUS
  opencode    bug-finder    ±   adapted for opencode: tools; added mode; commented model
  claude      bug-finder    ✓
  kilo        bug-finder    ±   adapted for kilo: tools; added mode; commented model
  cursor      bug-finder    ±   adapted for cursor: commented model; commented tools
  copilot     bug-finder    ±   adapted for copilot: tools mapped; commented model
  codex       bug-finder    ±   adapted for codex: converted to TOML; dropped tools
  windsurf    bug-finder    ±   adapted for windsurf: tools mapped; commented model

Installed 7.
```

## Why

Every AI coding tool expects these files in a different place, with a different extension and different frontmatter. Claude Code lists tools as `tools: Read, Bash`; OpenCode and Kilo want a boolean map; Copilot has its own tool aliases; Codex wants a TOML file. Hooks are JSON in one tool and a JavaScript plugin in another. MCP servers are `mcpServers` here, `mcp` there, and a TOML table somewhere else. Keeping one setup working across tools means hand-editing copies.

morf keeps the source in one git repo and does the translation on install.

## Supported tools

Global-scope tools install under your home directory. Project-scope tools install into the current working directory, so run morf from the project root.

| Target | Scope | Skills | Agents | Rules |
|---|---|---|---|---|
| `claude` (Claude Code) | global | `~/.claude/skills/<name>/` | `~/.claude/agents/<name>.md` | `~/.claude/rules/<name>.md` |
| `opencode` | global | `~/.config/opencode/skills/<name>/` | `~/.config/opencode/agent/<name>.md` | `~/.config/opencode/rules/<name>.md`, listed in `instructions` |
| `kilo` (Kilo Code v7+) | global | `~/.kilo/skills/<name>/` | `~/.kilo/agent/<name>.md` | `~/.kilo/rules/<name>.md`, listed in `instructions` |
| `codex` (OpenAI Codex CLI) | global | `~/.codex/skills/<name>/` | `~/.codex/agents/<name>.toml` | a block in `~/.codex/AGENTS.md` |
| `cursor` | project | `.cursor/skills/<name>/` | `.cursor/agents/<name>.md` | `.cursor/rules/<name>.mdc` |
| `copilot` (GitHub Copilot) | project | `.agents/skills/<name>/` | `.github/agents/<name>.md` | `.github/instructions/<name>.instructions.md` |
| `windsurf` (Devin Desktop) | project | `.devin/skills/<name>/` | `.devin/agents/<name>.md` | `.devin/rules/<name>.md` |

| Target | Prompts | Hooks | MCP servers |
|---|---|---|---|
| `claude` | `~/.claude/commands/<name>.md` | `hooks` in `~/.claude/settings.json` | `mcpServers` in `~/.claude.json` |
| `opencode` | `~/.config/opencode/commands/<name>.md` | generated plugin `~/.config/opencode/plugins/morf-<name>.js` | `mcp` in `~/.config/opencode/opencode.json` |
| `kilo` | `~/.kilo/commands/<name>.md` | generated plugin `~/.kilo/plugins/morf-<name>.js` | `mcp` in `~/.config/kilo/kilo.jsonc` |
| `codex` | `~/.codex/prompts/<name>.md` | `hooks` in `~/.codex/hooks.json` | `[mcp_servers.<name>]` in `~/.codex/config.toml` |
| `cursor` | `.cursor/commands/<name>.md` | `hooks` in `.cursor/hooks.json` | `mcpServers` in `.cursor/mcp.json` |
| `copilot` | `.github/prompts/<name>.prompt.md` | `.github/hooks/<name>.json` | `mcpServers` in `.mcp.json` |
| `windsurf` | `.devin/workflows/<name>.md` | `.devin/hooks.v1.json` | `mcpServers` in `.devin/mcp_config.json` |

Notes:

- **Windsurf.** Windsurf became Devin Desktop; morf writes to `.devin/`. If the project only has a legacy `.windsurf/` directory, skills, rules and workflows go there instead, and agents are written as rules (legacy Cascade has no agent format). Hooks and MCP config always go to `.devin/`.
- **OpenCode and Kilo** have no rule files. morf writes the rule as a plain Markdown file and adds its path to the `instructions` array in the tool's config.
- **Codex** reads instructions only from `AGENTS.md`, so each rule becomes a marked block in `~/.codex/AGENTS.md`. New hooks must be approved once with `/hooks` inside Codex.
- When a tool has no equivalent for a piece (for example a hook event it does not have), morf reports it as skipped or dropped with the reason. It never fails silently.

## What conversion does

Skills are copied as directories without modification. Everything else is rewritten for the target. The source repository is never changed.

**Agents**

- **Claude Code, OpenCode, Kilo.** `tools: Read, Bash` becomes a `read: true` / `bash: true` map for OpenCode and Kilo (and back again). A Claude tool list is an allow-list, so the other core tools are written as `false`. `mode: subagent` is added. `color`, `model` and `temperature` are checked against what OpenCode accepts.
- **Cursor.** Written as a native subagent. Cursor has no tool list, so an agent whose tools cannot write or run commands gets `readonly: true`.
- **Copilot.** Tools are mapped to Copilot's aliases (`read`, `edit`, `search`, `execute`, `agent`, `web`, `todo`).
- **Windsurf (Devin).** Tools are mapped to `allowed-tools` (`read`, `write`, `edit`, `exec`, `grep`, `glob`).
- **Codex.** Rewritten as a TOML custom agent: `name`, `description`, and the body as `developer_instructions`.

**Rules.** Glob scoping is translated: `globs` becomes `paths` for Claude Code, `applyTo` for Copilot, `trigger: glob` plus `globs` for Windsurf, and stays `globs` with `alwaysApply` for Cursor. OpenCode, Kilo and Codex cannot scope a rule to files, so the globs are written as an "Applies to" line in the text.

**Prompts.** Frontmatter is reduced to what each tool's command format accepts. For Copilot prompt files, `$ARGUMENTS` becomes `${input:arguments}`. Cursor commands are plain Markdown, so the frontmatter is removed.

**Hooks.** Event names, matcher tool names and the config shape are converted (`PreToolUse` becomes `preToolUse` for Cursor and Copilot, a `Bash` matcher becomes `Shell` for Cursor and `exec` for Devin). For OpenCode and Kilo, which have no hook config, morf generates a small plugin that runs the same commands on the matching plugin events and blocks the tool call when a `PreToolUse` command exits with code 2. Only `command` hooks are converted. Each tool sends its own JSON payload to the command, so a script that reads tool input may need adjusting per tool.

**MCP servers.** The entry is reshaped per tool (`command` + `args` versus a command array, `env` versus `environment`, `type` versus `transport`) and environment references are rewritten (`${VAR}`, `${env:VAR}` or `{env:VAR}`). For Codex it becomes a `[mcp_servers.<name>]` TOML table; a `Bearer ${TOKEN}` header becomes `bearer_token_env_var`.

Fields a tool does not understand are commented out in place with the reason, never deleted. Agent frontmatter conversion can be turned off with `morf config convert off`.

### Shared config files

Hooks, MCP servers and some rules live inside files you also edit by hand (`settings.json`, `.mcp.json`, `opencode.json`, `kilo.jsonc`, `config.toml`, `AGENTS.md`). morf changes only its own entries. Everything else in the file stays byte for byte as you wrote it, including comments in `.jsonc` files, key order and spacing. Its block in `AGENTS.md` and `config.toml` sits between begin and end markers, and morf never edits outside them. Installing twice does not duplicate an entry, and removing an entry puts the file back as it was. Files are written atomically. If a file cannot be parsed, morf reports the error and does not touch it.

Outside a project, before morf changes one of your files under the home directory for the first time, it saves the original next to it as `<file>.morf-backup`. The backup is made once and never overwritten. Inside a project no backup is made, since those files are under version control.

## Install

Requires Node.js 18 or newer and `git` on your PATH.

```sh
npm install -g @romivol/morf
```

Or run it once without installing:

```sh
npx @romivol/morf install <git-url>
```

## Usage

```sh
# install everything from a repo into every tool morf detects
morf install github.com/acme/agents

# or pin the tool you use most
morf config default claude

# install specific items into specific tools
morf install github.com/acme/agents --skill pdf-skill code-review --agent qa-agent --target claude cursor

# install one agent everywhere
morf install github.com/acme/agents --agent bug-finder --target all

# install an MCP server and a hook set
morf install github.com/acme/agents --mcp github --hook format-on-save

# preview without writing anything (the repo is still cloned so the preview is real)
morf install github.com/acme/agents --dry-run

# see what is installed, in every tool, including items morf did not install
morf list --all

# check every installed repo for a newer version
morf list --check-updates

# pull the latest version of everything morf manages
morf update --all

# remove an item from every tool it is installed in, without the confirmation prompt
morf uninstall --skill pdf-skill -y
```

### Commands

```
morf install   [<repo>] [--skill|--agent|--rule|--prompt|--hook|--mcp <name>...] [--all]
               [--target <tool>...|all] [--ref <branch>] [--force] [--dry-run]
morf update    [--skill|--agent|--rule|--prompt|--hook|--mcp <name>...] [--all]
               [--target <tool>...|all] [--ref <branch>] [--force] [--dry-run]
morf uninstall [<repo>] [--skill|--agent|--rule|--prompt|--hook|--mcp <name>...] [--all]
               [--target <tool>...|all] [--force | -y] [--dry-run]
morf list      [--all] [--check-updates] [--target <tool>...|all]
morf init
morf sync      [--frozen] [--check] [--prune] [--force] [--dry-run] [--yes] [--allow-exec]
morf config    default <tool> | repo <url> | alias <@name> <url> | unalias <@name>
               | convert on|off | unset default|repo | list
morf --help | --version
```

Flags worth knowing:

- `morf install <repo>` with no item flags installs everything in the repo.
- `--target` accepts several tools separated by spaces, or `all`. Without it, `install` uses your configured default tool; if none is set, every tool it detects (a global tool's config directory under your home, or a project tool's directory in the current project); if none is detected, `opencode`. `update` and `uninstall` act on every tool the item is installed in.
- `morf uninstall <repo> ...` removes only items that were installed from that repository, under any spelling of its address. With `--all` it means everything from that repository. If nothing here came from it, nothing is removed and the command exits 1.
- `--force` overwrites an item you edited locally, or one that already exists and was not installed by morf. Without it, morf skips the item and tells you.
- `--dry-run` prints what would change and writes nothing.
- `--allow-exec` lets morf install or replace hooks and MCP servers without asking. See below.
- `--ascii` replaces the unicode status symbols with `[OK]`-style tokens for terminals that cannot render them.
- `--all` on `list` also shows skills, agents, rules, prompts and MCP servers found in a tool's locations that morf did not install.

### Hooks and MCP servers are never installed silently

A hook or an MCP server is a command that will run on your machine, so morf does not install or replace one without a yes, whether or not you are in a project.

- In a terminal, morf lists each one with the command it will run and asks `Install the hooks and MCP servers listed above?` The default is No. If you decline, they are skipped and everything else you asked for is still installed.
- With no terminal, or when `CI` is set, morf never asks. It installs them only if you pass `--allow-exec`. Without the flag it prints the list, installs the other items, skips the hooks and MCP servers, and exits 1.
- This applies to `morf install` and `morf update`, including a bare `morf install <repo>`. `--yes`, `-y` and `--force` do not count as `--allow-exec`.
- Either way the summary ends with a line naming the hooks and MCP servers that were left out and why.
- Removing a hook or MCP server runs nothing, so `morf uninstall` never needs the flag.

Skills, agents, rules and prompts are not affected outside a project. Inside a project the stricter rule in [Nothing is installed without approval](#nothing-is-installed-without-approval) applies to every kind of item.

### What morf refuses or warns about in a source repository

- **Symbolic links and submodules.** An item that is one, or contains one, fails with a message naming it. morf never follows or copies a link and never fetches a submodule.
- **Names that cannot be made safe.** Item names are reduced to lowercase letters, digits, `.`, `_` and `-`. A name with nothing usable left (`..`, an empty name) is reported as a failure, by its original name.
- **Paths your system cannot hold.** If git cannot check out one of the repository's files here (a name the system does not allow, or a path that is too long), nothing from that repository is installed, and the message names the path.
- **Large items.** An item over 5 MB is pointed out with its size. There is no size limit.
- **Repository attributes.** A repository's `.gitattributes` has no effect on what morf checks out: no filters, no line-ending conversion.

### Upgrading from 1.1.2

Items you installed with 1.1.2 and have not edited are left exactly as they are, including their line endings, and show as up to date. Nothing is reported as locally edited because of the upgrade. Agents whose format morf has since corrected for a tool are updated the next time you run `morf update`.

### Aliases and a default repo

```sh
morf config repo github.com/acme/agents        # omit the repo argument from now on
morf config alias @core github.com/acme/core    # short name
morf install @core
```

## Projects: the project file and the lockfile

A project can pin exactly which skills, agents, rules, prompts, hooks and MCP servers it uses, so everyone on the team, and CI, gets the same setup.

Three files are involved. These are the names morf uses everywhere:

| Name | File | What it is |
|---|---|---|
| project file | `morf.json` in the project root | What the project asks for: repos, refs, items and tools. |
| lockfile | `morf.lock.json` in the project root | What the project file resolved to: the exact commit of each repo and a content hash of each item. |
| install record | `~/.morf/installed.json` | What is installed on this machine. Never committed. |

Commit the project file and the lockfile. Neither contains anything machine-specific: no absolute paths, no installed paths, no credentials. Both are written in a stable sorted order, so the same state always gives the same bytes.

```sh
morf init                                     # create an empty morf.json here
morf install github.com/acme/agents --agent bug-finder --target claude cursor
git add morf.json morf.lock.json              # commit both

# on another machine, or in CI
morf sync                                     # install exactly what the lockfile pins
```

### Project mode

A command runs in project mode when there is a `morf.json` in the current directory or the nearest parent directory. That directory is the project root.

In project mode every tool installs into its project-level directory under the project root. Nothing is written under your home directory.

| Tool | Skills | Agents | Rules | Prompts | Hooks | MCP servers |
|---|---|---|---|---|---|---|
| `claude` | `.claude/skills/` | `.claude/agents/` | `.claude/rules/` | `.claude/commands/` | `.claude/settings.json` | `.mcp.json` |
| `opencode` | `.opencode/skills/` | `.opencode/agents/` | `.opencode/rules/`, listed in `opencode.json` | `.opencode/commands/` | `.opencode/plugins/` | `opencode.json` |
| `kilo` | `.kilo/skills/` | `.kilo/agents/` | `.kilo/rules/`, listed in `kilo.jsonc` | `.kilo/commands/` | `.kilo/plugins/` | `kilo.jsonc` |
| `codex` | `.agents/skills/` | `.codex/agents/` | a block in `AGENTS.md` | not supported | `.codex/hooks.json` | `.codex/config.toml` |
| `cursor` | `.cursor/skills/` | `.cursor/agents/` | `.cursor/rules/` | `.cursor/commands/` | `.cursor/hooks.json` | `.cursor/mcp.json` |
| `copilot` | `.agents/skills/` | `.github/agents/` | `.github/instructions/` | `.github/prompts/` | `.github/hooks/` | `.mcp.json` |
| `windsurf` | `.devin/skills/` | `.devin/agents/` | `.devin/rules/` | `.devin/workflows/` | `.devin/hooks.v1.json` | `.devin/mcp_config.json` |

Things to know:

- **`--global`** forces the ordinary global behaviour even inside a project, and never touches `morf.json` or `morf.lock.json`. The same item can be installed globally and in any number of projects; they are separate and never overwrite each other.
- **Outside a project** (no `morf.json` found) every command behaves as described in the rest of this README.
- **Codex has no project-level prompts.** A prompt aimed at Codex is shown in the plan as unsupported and skipped. That is not an error and not drift.
- **Shared destinations.** Codex and Copilot both read `.agents/skills/`, and Claude Code and Copilot both read `.mcp.json`. morf writes such an item once and records every tool that owns it. Uninstalling it for one tool keeps it for the other; it is deleted when no owner is left. The shared `.mcp.json` entry is written in the shape both tools accept.
- **Codex rules go into the root `AGENTS.md`**, the only place Codex reads project instructions. OpenCode, Kilo, Cursor, Copilot and Windsurf read that file too, so a rule installed for Codex and one of them applies twice there. morf prints a warning in the plan when that happens.
- **Local repos.** A source given as a local path is stored relative to the project root, and morf warns that it will not resolve on other machines. A path that cannot be made relative (for example on another drive) is refused.
- **Which repository addresses are accepted.** In `morf.json` and `morf.lock.json` a repo must be an `https://` or `ssh://` URL, an address like `git@github.com:acme/agents.git`, or a relative local path starting with `./` or `../`. Anything else makes morf reject the whole file before it starts git: a value starting with `-`, anything containing `::`, control characters, and other schemes such as `http://`, `git://` and `file://`. A ref must be a name git itself would accept, and item names must be in the form morf writes them. On the command line the same rules apply, except that any local path and the `github.com/owner/repo` shorthand are also accepted.
- **Repo URLs are stored without credentials.** User names and tokens in an `https://` URL are stripped. A URL with a query string or fragment is refused, because morf cannot tell whether it holds a token.
- **Hashes are portable.** In project mode morf checks out the exact bytes git stores, with line-ending conversion switched off, so a lockfile written on Windows verifies on Linux and macOS.

### Commands in a project

| Command | What it does |
|---|---|
| `morf install <repo> ...` | Resolves the ref to a commit, installs into the project, and adds the entries to the project file and the lockfile. A repo that is already locked stays at its pinned commit. |
| `morf uninstall ...` | Removes the item from the project, from the project file and from the lockfile. |
| `morf update` | Moves every source to the latest commit of its ref, reinstalls what changed, and rewrites the lockfile. It works on whole sources: a repo has one pinned commit, so every item from that repo moves together. A single item cannot be updated on its own. |
| `morf sync` | Makes the project match the lockfile. |
| `morf sync --frozen` | The same, but never writes the project file or the lockfile, and fails where plain `sync` would adjust. This is the default when the `CI` environment variable is set. |
| `morf sync --check` | Read-only. Exits 0 if everything matches. Otherwise exits 1 and prints the drift. |

`morf sync` first validates everything, then prints the plan, then asks for approval, then installs. If validation fails or approval is not given, nothing changes.

| Situation | `morf sync` | `morf sync --frozen` |
|---|---|---|
| There is a project file but no lockfile | Resolves everything, installs, and creates the lockfile | Fails, changes nothing |
| The project file lists items the lockfile does not have | Resolves only those; everything else stays pinned | Fails, changes nothing |
| The lockfile has items the project file no longer lists | Offers to prune them (see below) | Fails, changes nothing |
| Neither file exists | Fails with a hint to run `morf init` | The same |
| An item is installed and matches | Does nothing | Does nothing |
| An item is installed but differs, and you did not edit it | Replaces it | Replaces it |
| You edited an item locally | Skips it, warns, lists it in the summary, and still exits 0 | Fails |
| You edited an item and passed `--force` | Overwrites it | Overwrites it |
| The pinned commit cannot be fetched | Fails, installs nothing | The same |
| The fetched content does not match the lockfile's hash | Fails, installs nothing, and names the item | The same |
| A tool in the project file is not installed on this machine | Writes its project files anyway | The same |

morf always fetches the exact pinned commit. If the host refuses a fetch by commit, it falls back to a full clone and checks that commit out. It never substitutes a different commit.

**Pruning.** Items installed for this project that are no longer in the lockfile are listed in the plan. They are removed only when you confirm interactively or pass `--prune`. With `--frozen` they are removed only with `--prune`.

**Drift.** `--check` reports two kinds separately: the lockfile against the project file, and the lockfile against what is on disk.

**Committed tool files.** If your team commits the installed files themselves (`.claude/agents/...` and so on), a fresh clone already has them, but this machine has no install record for them. morf compares each one with what it would write. If it is identical, morf treats it as installed and does nothing. If it differs, morf cannot tell your edit from an old version, so it treats the file as edited locally: plain `sync` skips it with a warning, `--frozen` fails, and `--force` overwrites it. One cause to know about: git on Windows may check committed files out with different line endings, which makes them differ.

**`--dry-run`.** With `--dry-run`, `install`, `update`, `uninstall` and `sync` print the plan and stop. Nothing changes and no question is asked, whatever `--yes`, `--allow-exec`, `--force` or `--prune` say, and the exit code is 0. If the plan cannot be built (a source cannot be fetched, a hash does not match, or `--frozen` finds the project file and lockfile out of step), the command still fails as it would without `--dry-run`.

### Nothing is installed without approval

In a project this applies to every kind of item, and to `install`, `update`, `uninstall` and `sync`.

morf prints the full plan first: every item it would install, replace, skip or prune, grouped by tool, with the source repo and commit.

In an interactive terminal:

- It asks `Apply these changes?` and the default is No. If you decline, it exits 1 and changes nothing.
- If the plan installs or replaces hooks or MCP servers, it lists them separately with the command each one runs and asks a second question, also defaulting to No. Declining that cancels the whole command.

In CI, with `--frozen`, or without a terminal:

- It never asks and never installs on its own.
- Installing needs `--yes`. Without it, morf prints the plan, exits 1 and changes nothing.
- Installing or replacing a hook or MCP server also needs `--allow-exec`. With `--yes` alone and one of those in the plan, morf prints them, exits 1 and installs nothing, not even the other items.
- Removing a hook or MCP server runs no code, so it never needs `--allow-exec`. `uninstall` needs only `--yes`, and pruning needs `--yes` and `--prune`.

`--yes` and `--allow-exec` apply to that one run only. They are never read from the project file, the lockfile, the config file or an environment variable, and `--yes` never implies `--allow-exec`. `morf sync --check` is read-only and needs neither.

A typical CI step:

```sh
morf sync --check                       # fail the build on drift, change nothing
morf sync --yes --allow-exec            # or: install exactly what is pinned
```

## Source repo layout

morf looks for these in the repository it clones. All of them are optional.

```
your-repo/
├── skills/
│   └── my-skill/
│       └── SKILL.md         # a directory is a skill if it contains SKILL.md
├── agents/
│   └── my-agent.md          # one Markdown file per agent, frontmatter + body
├── rules/
│   └── my-rule.md           # frontmatter: description, globs, alwaysApply
├── prompts/
│   └── my-prompt.md         # a slash command (commands/ is also read)
├── hooks/
│   └── my-hooks.json        # { "hooks": { "PreToolUse": [ ... ] } }
├── mcp/
│   └── my-server.json       # { "command": "npx", "args": [...], "env": {...} }
└── .mcp.json                # or one file with a "mcpServers" map
```

Write each file the way Claude Code expects it; morf converts from there.

A rule:

```md
---
description: TypeScript conventions
globs: src/**/*.ts, src/**/*.tsx
---
- Use named exports
```

A hook set:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check.sh" }] }
    ]
  }
}
```

An MCP server (`mcp/context7.json`), stdio or remote:

```json
{ "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "env": { "API_KEY": "${API_KEY}" } }
```

```json
{ "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
```

## How it works

```
morf install <repo>
   │
   ├─ repo/git.js                shallow-clone the repo to a temp dir (or report a clear
   │                             error: bad ref, auth failure, repo not found, network)
   ├─ repo/scan.js               find skills, agents, rules, prompts, hooks and MCP servers
   ├─ install/targets.js         resolve where each (target, type) pair is stored, and how
   ├─ convert/*.js               rewrite the item for the target, one module per primitive
   ├─ install/engine.js          decide what to do (install, replace, skip) and do it
   ├─ install/store.js           write the file, or merge the entry into a shared config file
   └─ install/install-record.js  update the install record, ~/.morf/installed.json
```

The install record is what makes `update`, `uninstall` and the local-edit check possible. Before overwriting, morf hashes what is on disk (the file, the config entry, or the marked block) and compares it with the hash it recorded at install time. A mismatch means you edited it, so morf skips it unless you pass `--force`.

Configuration lives in `~/.morf/config.json`. Both files are written atomically. A corrupt install record is backed up and replaced rather than crashing the command. If you used the earlier `ray` tool, its `~/.ray` config and install record are migrated on first run.

The whole tool is plain Node.js with zero runtime dependencies. Frontmatter, JSON-with-comments and TOML output are handled by hand, so no parser library is needed.

## Project layout

```
bin/cli.js                    entry point
src/
  cli.js                      argument parsing, help text, dispatch, project detection
  commands/                   one file per command
    install.js update.js uninstall.js list.js config.js      global mode
    init.js sync.js project-install.js project-uninstall.js  project mode
  convert/                    text conversion, one module per primitive
    agents.js rules.js prompts.js hooks.js mcp.js
    frontmatter.js            line-based frontmatter helpers
    shared.js                 pieces the converters share
  install/                    where items go, how they are written, and the record of it
    targets.js                per-tool storage tables (global and project), scope, detection
    engine.js                 prepare / commit / remove one item for one target
    store.js                  read, write and remove an item (files and merged config)
    json-edit.js              edits to shared JSON(C) files that leave every other byte alone
    json-file.js              tolerant JSON(C) reading, atomic writes, canonical hashing
    install-record.js         the install record, ~/.morf/installed.json
  project/                    project mode
    project-file-and-lockfile.js   morf.json and morf.lock.json
    plan.js                   build and apply a plan
    approve.js                print the plan; the approval gate (--yes, --allow-exec)
  repo/                       getting the source
    git.js                    clone, exact-commit fetch, git error classification
    url.js                    repo URL normalising, shorthand, credential stripping
    scan.js                   discover primitives in a source repo
  util/                       low-level helpers
    fs.js sanitize.js log.js table.js messages.js banner.js config.js assets/
test/                         node --test suites, mirroring src/
docs/design/                  design notes
docs/unverified.md            paths and behaviours not yet checked in the real tools
```

## Development

```sh
git clone https://github.com/romivol/morf-source-code.git
cd morf-source-code
npm install
npm test        # node --test
npm run lint    # eslint
npm run test:count   # guard: the runner reports every test that is defined
node bin/cli.js --help
```

CI runs lint and tests on Node 18, 20 and 22. See [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions.

## Roadmap

- Public registry with `morf search` and short-name installs
- A user-level lockfile for a personal global setup (the lockfile is per project for now)
- `morf publish`

## License

MIT. See [LICENSE](./LICENSE).
