Add OpenAI Codex CLI as a 7th morf target: `codex`.

## Research findings (verified, use as-is)

- Codex supports the standard SKILL.md format (same spec as Claude/OpenCode/Kilo/Cursor).
  It reads skills from a **global** directory: `~/.codex/skills/<name>/SKILL.md`.
- Codex has **no per-agent file format** like Claude/OpenCode/Kilo (no single .md file with
  tools/model/permission frontmatter for individual named agents). Codex's equivalent concept
  is a single project-wide `AGENTS.md` instructions file — a different primitive entirely, not
  a per-agent file. So for morf's existing `agent` type, Codex should behave exactly like
  Kilo's `hook: null` does today: **not supported**, with the existing friendly error path
  (`resolveDestination` already throws "X does not support Ys. Try a different --target, or
  omit this item." for any type mapped to `null`).
- Do NOT invent an AGENTS.md conversion in this pass — just mark `agent: null` for codex, same
  pattern as `hook: null` for opencode/kilo/cursor/copilot/windsurf already does. AGENTS.md
  support can be a separate future feature (rules/instructions primitive), not part of this task.
- Codex is **global-scope** (like claude/opencode/kilo — base path under the user's home
  directory), NOT project-scope like cursor/copilot/windsurf.

## Where to change it

In `src/targets.js`, inside `getTargets(cwd)`, add a new entry alongside the existing
`opencode`/`claude`/`kilo`/`cursor`/`copilot`/`windsurf` entries (follow the exact same object
shape used by those — see `displayName`, `scope`, `types.skill`, `types.agent`, `types.hook`):

```js
codex: {
  displayName: 'Codex CLI',
  scope: 'global',
  types: {
    skill: { kind: 'dir', base: join(home, '.codex', 'skills') },
    agent: null,   // Codex has no per-agent file format — see research notes above
    hook:  null,
  },
},
```

That's the only change needed to `targets.js` — `listTargets()`, `expandTargets('all')`,
`isValidTarget()`, and the CLI help text all derive from this object automatically, so they'll
pick up `codex` with no further edits.

## Also update

1. **README.md** — add a row to the "Supported tools" table:
   `| \`codex\` (OpenAI Codex CLI) | global | \`~/.codex/skills/<name>/\` | — (no agent format; skills only) |`
2. **tests/morf-v2.test.js** — add tests analogous to the existing target tests:
   - `listTargets()` includes `'codex'` and the total count is now 7.
   - `expandTargets('all')` length is 7.
   - `targetScope('codex') === 'global'`.
   - `resolveDestination('codex', 'skill').base` equals `join(homedir(), '.codex', 'skills')`.
   - `resolveDestination('codex', 'agent', ...)` throws `/does not support agents/`.
3. Run the full test suite (`node --test`) and confirm everything is green, including the
   existing 277 tests plus your new ones.
4. Bump `package.json` version (minor bump, e.g. `2.0.0` → `2.1.0`) since this is a new feature,
   and regenerate the npm tarball if you produce one (`npm pack`).

## What NOT to do

- Don't add a `codex` case to `convert.js`'s per-target agent adaptation — there's nothing to
  adapt since agents aren't supported for this target.
- Don't touch the `install`/`update`/`uninstall`/`list` command files — they're all
  target-agnostic and already loop over whatever `listTargets()`/`expandTargets()` return.
- Don't change the project-scope windsurf/cursor/copilot logic — codex is unrelated to that path.
