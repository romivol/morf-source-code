# Unverified paths and behaviours

Everything here was implemented from each tool's documentation and has **not** been checked by loading the result in the real tool. Use it as the checklist for real-tool verification. When an item is confirmed, move it to the "Verified" section with the tool version and date.

All tests in this repository check that morf *writes* the right bytes. None of them prove that a tool *reads* them.

## Status of real-tool verification

| Tool | Status |
|---|---|
| Claude Code | **Verified** in version 2.1.332 on 2026-11-25, in project mode and global mode, for all six kinds of item. One exception: a global MCP server (`~/.claude.json`) was not tested. |
| OpenCode, Kilo, Codex, Cursor, Copilot, Windsurf (Devin) | **Not verified.** Nothing morf writes for these tools has been loaded in the tool, apart from the two Copilot CLI checks in the table below. Everything in this file about them still comes from documentation. |

## Verified

| What | How | Tool version | Date |
|---|---|---|---|
| Claude Code loads a project `.mcp.json` stdio entry written in the shared shape (`type: "stdio"` plus `tools: ["*"]`) | Wrote the entry next to a plain one; both servers connected and exposed their tool, through `--mcp-config` and through project discovery | Claude Code 2.1.332 | 2026-11-25 |
| Claude Code, project mode: skill, agent, rule, prompt, hook and stdio MCP server are loaded from `.claude/skills/`, `.claude/agents/`, `.claude/rules/`, `.claude/commands/`, `hooks` in `.claude/settings.json` and `.mcp.json` | Listed by the tool: the headless session start lists the skill, agent, command and the MCP server as connected; `claude mcp get` shows the server with scope "Project config". Observed working: headless runs returned the rule's phrase with no tool call, the command's output, the subagent's reply, the skill's reply and the MCP tool's text; the hook wrote its marker line on prompt submit and before a Bash call. | Claude Code 2.1.332 | 2026-11-25 |
| Claude Code, global mode: skill, agent, rule, prompt and hook are loaded from `~/.claude/skills/`, `~/.claude/agents/`, `~/.claude/rules/`, `~/.claude/commands/` and `hooks` in `~/.claude/settings.json` | Same two kinds of evidence, run from a directory with no project files. After uninstall `~/.claude/settings.json` and every existing file under the four directories were byte-identical to a backup. | Claude Code 2.1.332 | 2026-11-25 |
| Claude Code asks once before running a project MCP server | `claude mcp get` reports "Pending approval" for the entry morf wrote; it connects once approved (tested with `enableAllProjectMcpServers` in `.claude/settings.local.json`). | Claude Code 2.1.332 | 2026-11-25 |
| A remote MCP server in the project `.mcp.json` is written without a `tools` key, and Claude Code lists it | Claude Code drops a remote entry (`type: "http"`) that carries `tools`, without any message: `claude mcp get` says there is no such server. The same entry without `tools` is listed, and so is a local (stdio) entry with `tools`. morf now writes `tools` on local entries only. `test/project/shared-mcp.test.js` installs a remote server and asks `claude mcp get` for it (run with `MORF_REAL_TOOL_TESTS=1`); it fails against the old output. | Claude Code 2.1.332 | 2026-11-25 |
| Copilot CLI reads the project `.mcp.json` and does not need `tools` | `copilot mcp list --json` in a trusted folder listed local and remote entries with and without `tools`, and showed `tools: ["*"]` for all of them. An untrusted folder is skipped with a warning. Listing only: no server was started and no model was called, because Copilot is not signed in here. GitHub's documentation gives `*` as the default. | Copilot CLI 1.0.116 | 2026-11-25 |

## Project-level destinations (project mode)

| Tool | Item | Path | Doubt |
|---|---|---|---|
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
