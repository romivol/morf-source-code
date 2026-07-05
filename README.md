# morf

[![npm version](https://img.shields.io/npm/v/morf.svg)](https://www.npmjs.com/package/morf)
[![license](https://img.shields.io/npm/l/morf.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/morf.svg)](https://nodejs.org)

**one agent, every tool.**

morf installs AI skills & agents from any git repo into every AI coding tool at once — and converts each one into the tool's native format, not just copies it.

🔗 **[morf.tools](https://morf.tools)** — docs, comparison, full conversion matrix

```
$ morf install github.com/acme/agents --agent bug-finder --target all

*** claude ***
✓ bug-finder
*** cursor ***
± bug-finder          (converted to a .mdc rule)
*** kilo ***
± bug-finder          (tools remapped)
*** copilot ***
± bug-finder          (tools mapped)
*** windsurf ***
✓ bug-finder
*** opencode ***
± bug-finder          (tools remapped)
*** codex ***
—  bug-finder          (Codex has no agent format — skills only)

morfed 1 agent → 6 tools, 1 skipped
```

## Why

Every AI tool speaks its own dialect. A skill, an agent, a rule — each tool wants a different folder, a different extension, different frontmatter. morf is the translator: write it once, `morf` it everywhere.

## Supported tools

| Tool | Scope | Skills | Agents |
|------|-------|--------|--------|
| `claude` (Claude Code) | global | `~/.claude/skills/<name>/` | `~/.claude/agents/<name>.md` |
| `opencode` | global | `~/.config/opencode/skills/<name>/` | `~/.config/opencode/agent/<name>.md` |
| `kilo` (Kilo Code v7+) | global | `~/.kilo/skills/<name>/` | `~/.kilo/agent/<name>.md` |
| `codex` (OpenAI Codex CLI) | global | `~/.codex/skills/<name>/` | — (no agent format; skills only) |
| `cursor` | project | `.cursor/skills/<name>/` | `.cursor/rules/<name>.mdc` |
| `copilot` (GitHub Copilot) | project | `.agents/skills/<name>/` | `.github/agents/<name>.md` |
| `windsurf` (Devin) | project | `.devin/skills/<name>/` | `.devin/rules/<name>.md` |

- **Global-scope** tools (`claude`, `opencode`, `kilo`, `codex`) install under your home directory.
- **Project-scope** tools (`cursor`, `copilot`, `windsurf`) install into the current directory — run morf from your project root.
- Windsurf: morf prefers the new `.devin/` directory (post-rebrand) and falls back to an existing `.windsurf/`.
- A tool that doesn't support a given primitive is skipped with a clear reason (`—`), never silently ignored.

## Real conversion, not copying

On install, morf rewrites each agent's frontmatter for the target:

- **Tool names** — `Read, Bash` (Claude) ↔ `read: true` maps (OpenCode/Kilo)
- **Unsupported fields** — commented out (never silently dropped), with the reason inline
- **Cursor** — agents become `.mdc` rules (`alwaysApply: false` added)
- **Field validation** — model/color/temperature checked against each tool's expectations

Your source repo is never modified. Disable conversion with `morf config convert off`.

## Install

```sh
npm install -g morf
# or one-off:
npx morf install <git-url> --all
```

**Requirement:** `git` must be installed on your machine.

## Quick start

```sh
# 1. Set your primary tool once
morf config default claude

# 2. Install from any git repo
morf install github.com/acme/agents --all

# 3. See what's installed, everywhere
morf list
```

## Commands

```
morf install   [<repo>] [--skill <name>]... [--agent <name>]... [--all]
                        [--target <tool>|all] [--ref <branch>] [--force] [--dry-run]
morf update    [--skill <name>]... [--agent <name>]... [--all] [--target <tool>|all]
morf uninstall [<repo>] [--skill <name>]... [--agent <name>]... [--all] [--force | -y]
morf list      [--all-on-disk] [--check-updates] [--target <tool>|all]
morf config    default <tool> | repo <url> | alias <@name> <url> | unalias <@name>
               | convert on|off | unset default|repo | list
morf --help | --version
```

Useful flags:
- `--target all` — install to every tool at once
- `--dry-run` — preview without writing (still clones, so the preview is real)
- `--force` — overwrite locally-edited items (morf never overwrites your edits silently)
- `--check-updates` — check every installed repo for a newer version without installing
- `--ascii` — classic `[OK]`-style tokens instead of unicode symbols (also `MORF_ASCII=1`)

## Repo layout morf understands

```
your-repo/
├── skills/
│   └── my-skill/
│       └── SKILL.md      # Agent Skills spec (name must match folder)
└── agents/
    └── my-agent.md       # frontmatter + markdown body
```

## Config

Stored in `~/.morf/config.json`:

```sh
morf config default cursor            # default install target
morf config repo github.com/org/repo  # default repo (skip typing it)
morf config alias @core github.com/org/core-skills
morf install @core --all
```

Coming from `ray`? Your existing `~/.ray` config and manifest are migrated automatically on first run.

## Safety

- Never overwrites local edits without `--force` (content-hash tracked in `~/.morf/installed.json`)
- Never modifies the source repo
- Zero runtime dependencies — the entire tool is auditable stdlib Node
- `--dry-run` everywhere

## Contributing

Issues and PRs are welcome — this is early-stage and there's a lot of surface left (see Roadmap).
Before opening a PR, please:

```sh
git clone https://github.com/PLACEHOLDER/morf.git
cd morf
node --test        # full suite should pass
```

Good first contributions: a new target's conversion rules, README fixes, or test coverage for
edge cases in `src/convert.js`.

## Roadmap

- Rules, prompts, hooks & MCP-server conversion (full 6-primitive matrix)
- Public registry: `morf search` & short-name installs
- Lockfile & `morf sync` for reproducible setups
- `morf publish`

## License

MIT © Romi Volkovich
