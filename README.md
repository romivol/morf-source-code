# morf

[![npm version](https://img.shields.io/npm/v/%40romivol%2Fmorf.svg)](https://www.npmjs.com/package/@romivol/morf)
[![CI](https://github.com/romivol/morf/actions/workflows/ci.yml/badge.svg)](https://github.com/romivol/morf/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**One agent, every tool.**

morf is a command-line package manager for AI coding skills and agents. It installs them from any git repository into the AI coding tools you use, and converts each one into that tool's native format instead of copying the file as-is.

Website: [morf.tools](https://morf.tools)

```
$ morf install github.com/acme/agents --agent bug-finder --target all

  TARGET      NAME          STATUS
  opencode    bug-finder    ±   adapted for opencode: tools
  claude      bug-finder    ✓
  kilo        bug-finder    ±   adapted for kilo: tools
  cursor      bug-finder    ±   adapted for cursor: commented tools, model; added alwaysApply   (project-scoped)
  copilot     bug-finder    ±   adapted for copilot: commented tools, model   (project-scoped)
  codex       bug-finder    ⊘   not supported by codex
  windsurf    bug-finder    ±   adapted for windsurf: commented tools, model   (project-scoped)

Installed 6, skipped 1.
```

## Why

Every AI coding tool expects skills and agents in a different place, with a different file extension and different frontmatter. Claude Code lists tools as `tools: Read, Bash`; OpenCode and Kilo want a boolean map; Cursor wants a `.mdc` rule with `alwaysApply`; Codex has no agent format at all. Keeping one agent working across tools means hand-editing copies.

morf keeps the source in one git repo and does the translation on install.

## Supported tools

| Target | Scope | Skills go to | Agents go to |
|---|---|---|---|
| `claude` (Claude Code) | global | `~/.claude/skills/<name>/` | `~/.claude/agents/<name>.md` |
| `opencode` | global | `~/.config/opencode/skills/<name>/` | `~/.config/opencode/agent/<name>.md` |
| `kilo` (Kilo Code v7+) | global | `~/.kilo/skills/<name>/` | `~/.kilo/agent/<name>.md` |
| `codex` (OpenAI Codex CLI) | global | `~/.codex/skills/<name>/` | not supported, skills only |
| `cursor` | project | `.cursor/skills/<name>/` | `.cursor/rules/<name>.mdc` |
| `copilot` (GitHub Copilot) | project | `.agents/skills/<name>/` | `.github/agents/<name>.md` |
| `windsurf` (Devin) | project | `.devin/skills/<name>/` | `.devin/rules/<name>.md` |

Global-scope targets install under your home directory. Project-scope targets install into the current working directory, so run morf from the project root. For Windsurf, morf writes to `.devin/` and falls back to an existing `.windsurf/` directory if there is no `.devin/`.

When a target does not support a primitive, morf reports it as skipped with the reason. It never fails silently.

## What conversion does

On install, morf rewrites agent frontmatter for the target:

- **Tool lists.** `tools: Read, Bash` (Claude style, inline or YAML list) becomes a `read: true` / `bash: true` map for OpenCode and Kilo, and back again in the other direction.
- **Field validation for OpenCode and Kilo.** `color`, `model` and `temperature` are checked against what those tools accept. `permission` is not supported in their agent frontmatter. Invalid fields are commented out in place with the reason, never deleted.
- **Cursor.** Only `description`, `globs` and `alwaysApply` are kept. Everything else is commented out, and `alwaysApply: false` is added so the file is a valid rule.
- **Copilot and Windsurf.** Same allow-list approach: `description` for Copilot; `description`, `globs` and `trigger` for Windsurf.

Skills are copied as directories without modification. The source repository is never changed. Conversion can be turned off with `morf config convert off`.

## Install

Requires Node.js 18 or newer and `git` on your PATH.

```sh
npm install -g @romivol/morf
```

Or run it once without installing:

```sh
npx @romivol/morf install <git-url> --all
```

## Usage

```sh
# set the tool you use most (optional; defaults to opencode)
morf config default claude

# install everything from a repo into your default tool
morf install github.com/acme/agents --all

# install specific items into specific tools
morf install github.com/acme/agents --skill pdf-skill code-review --agent qa-agent --target claude cursor

# install one agent everywhere
morf install github.com/acme/agents --agent bug-finder --target all

# preview without writing anything (the repo is still cloned so the preview is real)
morf install github.com/acme/agents --all --dry-run

# see what is installed, across every tool
morf list

# check every installed repo for a newer version
morf list --check-updates

# pull the latest version of everything morf manages
morf update --all

# remove an item without the confirmation prompt
morf uninstall --skill pdf-skill -y
```

### Commands

```
morf install   [<repo>] [--skill <name>...] [--agent <name>...] [--all]
               [--target <tool>...|all] [--ref <branch>] [--force] [--dry-run]
morf update    [--skill <name>...] [--agent <name>...] [--all]
               [--target <tool>...|all] [--ref <branch>] [--force] [--dry-run]
morf uninstall [<repo>] [--skill <name>...] [--agent <name>...] [--all]
               [--target <tool>...|all] [--force | -y] [--dry-run]
morf list      [--all-on-disk] [--check-updates] [--target <tool>...|all]
morf config    default <tool> | repo <url> | alias <@name> <url> | unalias <@name>
               | convert on|off | unset default|repo | list
morf --help | --version
```

Flags worth knowing:

- `--target` accepts several tools separated by spaces, or `all`.
- `--force` overwrites an item you edited locally. Without it, morf skips the item and tells you.
- `--dry-run` prints what would change and writes nothing.
- `--ascii` replaces the unicode status symbols with `[OK]`-style tokens for terminals that cannot render them.
- `--all-on-disk` on `list` also shows skills and agents in a tool's directory that morf did not install.

### Aliases and a default repo

```sh
morf config repo github.com/acme/agents        # omit the repo argument from now on
morf config alias @core github.com/acme/core    # short name
morf install @core --all
```

## Source repo layout

morf looks for two top-level directories in the repository it clones:

```
your-repo/
├── skills/
│   └── my-skill/
│       └── SKILL.md       # a directory is a skill if it contains SKILL.md
└── agents/
    └── my-agent.md        # one markdown file per agent, frontmatter + body
```

Either directory may be missing.

## How it works

```
morf install <repo>
   │
   ├─ git.js        shallow-clone the repo to a temp dir (or report a clear error:
   │                bad ref, auth failure, repo not found, network)
   ├─ scan.js       find skills/*/SKILL.md and agents/*.md
   ├─ targets.js    resolve the destination path for each (target, type) pair
   ├─ convert.js    rewrite agent frontmatter for the target
   ├─ fsops.js      copy, then hash what was written
   └─ manifest.js   record source hash + installed hash in ~/.morf/installed.json
```

The manifest is what makes `update`, `uninstall` and the local-edit check possible. Before overwriting, morf hashes the file on disk and compares it with the hash it recorded at install time. A mismatch means you edited it, so morf skips it unless you pass `--force`.

Configuration lives in `~/.morf/config.json`. Both files are written atomically. A corrupt manifest is backed up and replaced rather than crashing the command. If you used the earlier `ray` tool, its `~/.ray` config and manifest are migrated on first run.

The whole tool is plain Node.js with zero runtime dependencies. Frontmatter is parsed by hand, so no YAML library is needed.

## Project layout

```
bin/cli.js        entry point
src/cli.js        argument parsing and command dispatch
src/commands/     install, update, uninstall, list, config
src/convert.js    frontmatter and tool-name conversion per target
src/targets.js    per-tool install locations and scope
src/git.js        clone and git error classification
src/manifest.js   ~/.morf/installed.json
src/config.js     ~/.morf/config.json
src/scan.js       discover skills and agents in a repo or on disk
src/sanitize.js   name sanitization and path-traversal guards
src/table.js      aligned terminal tables
src/log.js        colors, status symbols, spinner
src/messages.js   all user-facing strings
test/             node --test suites
docs/design/      design notes
```

## Development

```sh
git clone https://github.com/romivol/morf.git
cd morf
npm install
npm test        # node --test
npm run lint    # eslint
node bin/cli.js --help
```

CI runs lint and tests on Node 18, 20 and 22. See [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions.

## Roadmap

- Conversion for rules, prompts, hooks and MCP server definitions
- Public registry with `morf search` and short-name installs
- Lockfile and `morf sync` for reproducible setups
- `morf publish`

## License

MIT. See [LICENSE](./LICENSE).
