# Unverified paths and behaviours

Everything here was implemented from each tool's documentation and has **not** been checked by loading the result in the real tool. Use it as the checklist for real-tool verification. When an item is confirmed, move it to the "Verified" section with the tool version and date.

All tests in this repository check that morf *writes* the right bytes. None of them prove that a tool *reads* them.

## Verified

| What | How | Tool version | Date |
|---|---|---|---|
| Claude Code loads a project `.mcp.json` stdio entry written in the shared shape (`type: "stdio"` plus `tools: ["*"]`) | Wrote the entry next to a plain one; both servers connected and exposed their tool, through `--mcp-config` and through project discovery | Claude Code 2.1.332 | 2026-11-25 |

## Project-level destinations (project mode)

| Tool | Item | Path | Doubt |
|---|---|---|---|
| Claude Code | skills, agents, rules, prompts, hooks | `.claude/skills/`, `.claude/agents/`, `.claude/rules/`, `.claude/commands/`, `hooks` in `.claude/settings.json` | Documented; not loaded in the tool. |
| Claude Code + Copilot | MCP, remote server | `.mcp.json`, `{ "type": "http", "url", "headers", "tools": ["*"] }` | Only the stdio shape was tested. Does Claude Code accept the extra `tools` key on a remote entry? Does Copilot accept this entry at all? |
| Claude Code | MCP | `.mcp.json` | Project servers need a one-time approval in Claude Code before they run. |
| OpenCode | rules | `.opencode/rules/<name>.md`, listed in root `opencode.json` `instructions` as `.opencode/rules/<name>.md` | **How a relative `instructions` path is resolved is not confirmed.** Assumed: relative to the project root. |
| OpenCode | agents, prompts, plugins | `.opencode/agents/`, `.opencode/commands/`, `.opencode/plugins/` | Plural names are canonical in OpenCode 2; assumed also read by 1.x. |
| OpenCode | config file | root `opencode.json` (or an existing `opencode.jsonc`) | Not checked against `.opencode/opencode.json`, which the docs say takes precedence if present. |
| Kilo | everything | `.kilo/skills/`, `.kilo/agents/`, `.kilo/rules/` + `instructions`, `.kilo/commands/`, `.kilo/plugins/`, `mcp` in root `kilo.jsonc` | Documented; not loaded. Relative `instructions` path, as for OpenCode. |
| Codex | skills | `.agents/skills/<name>/` | Documented. Shared with Copilot. |
| Codex | agents | `.codex/agents/<name>.toml` | Documented; not loaded. |
| Codex | rules | marked block in root `AGENTS.md` | Works by definition, but the same file is read by OpenCode, Kilo, Cursor, Copilot and Windsurf. |
| Codex | hooks, MCP | `.codex/hooks.json`, `[mcp_servers.<name>]` in `.codex/config.toml` | **Honoured only for trusted projects.** New hooks must also be approved with `/hooks`. Not tested. |
| Codex | prompts | none | Codex has no project-level prompts; morf skips them. |

## Global destinations

| Tool | Item | Path | Doubt |
|---|---|---|---|
| Claude Code | prompts | `~/.claude/commands/<name>.md` | The global path was not in the doc text that was read. |
| Claude Code | MCP | `mcpServers` at the top level of `~/.claude.json` | Exact nesting for user scope not confirmed. Claude Code rewrites this file itself; install while it is not running. |
| Codex | skills | `~/.codex/skills/<name>/` | **Not in Codex's current docs**, which list `~/.agents/skills`. Left as it was. |
| Kilo | everything | `~/.kilo/...` with config in `~/.config/kilo/kilo.jsonc` | `~/.kilo` is scanned according to the source; not loaded. |
| Windsurf | prompts | `.devin/workflows/<name>.md` | Workflows are documented only for legacy Cascade. Whether Devin Local runs them is not stated. |
| Copilot | MCP | `.mcp.json` | The portable format. `.vscode/mcp.json` (`servers`) is the older editor-managed format and is not written. |

## Conversions

| What | Doubt |
|---|---|
| OpenCode / Kilo hook plugin | **OpenCode 1.x and Kilo format only** (one named export returning a hooks object). OpenCode's docs say 1.x plugins do not run in OpenCode 2. The generated file has never been executed in either tool. |
| Hook payloads | Event names, matchers and config shape are converted, but each tool sends its own JSON on stdin. A script that reads tool input may need changes per tool. |
| Cursor hook matchers | `Bash` → `Shell`, `Edit` → `Write` is a best reading of Cursor's docs, not a documented mapping. |
| Copilot hooks | Written with the documented camelCase event names and a cross-platform `command`. Matchers are passed through unchanged; Copilot's tool names differ from Claude Code's. |
| Devin hooks | Matcher tool names mapped (`Bash` → `exec`, ...). `PostCompact` → `PostCompaction` assumed equivalent. |
| OpenCode / Kilo agents | Written in the 1.x shape (`tools` map, `mode`). OpenCode 2 is documented to read and translate it. |
| Cursor agents | `readonly: true` is derived when an agent's tools cannot write or run commands. |
| Codex agents | TOML with `name`, `description`, `developer_instructions`. Tool restrictions are dropped: the format has none. |
| Cursor prompts | Frontmatter is removed. Whether Cursor expands `$ARGUMENTS` in a command file is not documented. |
| Codex MCP | `KEY = "${KEY}"` becomes `env_vars`, and `Authorization: Bearer ${TOKEN}` becomes `bearer_token_env_var`. Other `${VAR}` references are written as literal text, which Codex does not expand. |

## Behaviours

| What | Doubt |
|---|---|
| Fetch by commit | Tested against local repositories and against GitHub (`test/repo/network.test.js`: direct fetch by SHA, the full-clone fallback, and a refused non-existent commit). Not tested against GitLab, Bitbucket or a self-hosted server, or against a private repository. |
| Portable hashes | Verified in CI: `test/util/portable-hash.test.js` reproduces the stored constant on ubuntu-latest, macos-latest and windows-latest, on Node 18 and the current LTS. Not checked on other systems or filesystems (for example a case-insensitive or Unicode-normalising volume with non-ASCII file names). |
| CI workflow | `.github/workflows/ci.yml` has run green on all six jobs (three systems, Node 18 and the current LTS). The newest Node release is not in the matrix. |
| Committed tool files on another OS | A project that commits its installed files may check them out with different line endings on Windows (the user's own `core.autocrlf`), in which case morf sees them as edited. |
| An object that was empty (`{}`) | After morf adds and removes an entry it is left as `{` `}` on two lines; morf cannot know the original spacing. |
| Interactive prompts | Tested through an injected terminal, not a real TTY. |
| `morf update` in a project | Moves whole sources: every item from a repo follows that repo's ref. Updating a single item is not possible, because a source has one commit. |

## Open issues

Known behaviour that is probably not what a user expects. These are not unverified guesses; they are how the code works today.

| What | Detail |
|---|---|
| One uncheckable path fails the whole repository | If git cannot create one file of a source repository on this system, nothing from that repository can be installed here, even items that have nothing to do with that file. The message names the path. Left as it is by decision. |
| No size limit | An item of any size is installed; over 5 MB it is flagged with a warning. Left as it is by decision. |
| File names with control characters, backslash or colon | The test for these builds its repository through git, and git on Windows refuses to record such names, so that test runs on Linux and macOS only. |
