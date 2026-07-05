Redesign morf's terminal output for `install`, `update`, `uninstall`, and `list` as aligned
tables instead of the current repeated `*** target ***` header blocks. Keep it minimal-rule
(thin header + underline, padded columns) — NOT heavy box-drawing (no ┌─┬─┐ borders). This
should match the calm, restrained terminal aesthetic already established (single accent color,
no decoration for its own sake).

## Why this is feasible without losing the live/streaming feel

Before the per-target loop starts, `install`/`update`/`uninstall` already know the full list of
concrete targets (`expandTargets(target)`) and the full list of selected items. That means
column widths (the `TARGET` column width = longest target name in this run; the `NAME` column
width = longest item name in this run) can be computed ONCE up front, then each result row is
still printed as it completes — same live behavior as today, just aligned into a table instead
of stacked under repeated headers.

## `morf install` / `update` / `uninstall` — target layout

Print one header row once (after the initial "Cloning..." line, before the first result), then
stream rows below it as each item/target completes — do not buffer and print all at once.

```
  TARGET      NAME           STATUS
  opencode    find-skills    ✓
  claude      find-skills    ✓
  kilo        find-skills    ✓
  cursor      find-skills    ✓   (project-scoped)
  copilot     find-skills    ⊘   local changes — re-run with --force
  codex       find-skills    ✓
  windsurf    find-skills    ✓   (project-scoped)

  6 installed · 1 skipped
  re-run with --force to overwrite skipped items
```

Column rules:
- `TARGET` — left-aligned, width = longest target name in this run + 2 spaces padding.
- `NAME` — left-aligned, width = longest item name in this run + 2 spaces padding. If multiple
  items are installed per target (e.g. `--all` with several skills/agents), each gets its own
  row (so `TARGET` may repeat across consecutive rows for the same target — that's fine, it's
  still more scannable than today's repeated `***` header blocks).
- `STATUS` — the existing symbol (✓ ↑ ⊘ — ± ✗), left-aligned.
- Trailing note — anything that today prints as a separate indented `note:`/`error:` line
  (project-scoped hint, "local changes", "adapted agent for X", clone errors) becomes a dimmed
  trailing fragment on the SAME row, after the status symbol, instead of a second line. Keep it
  short — if a note is long, it's fine for it to wrap or truncate; don't sacrifice row alignment
  for it. Multi-target project-scope hints (currently a whole separate dim line like
  "(cursor is project-scoped — installing into the current directory)") should collapse into a
  short trailing tag like `(project-scoped)` per row, not a separate line — the fuller
  explanation can move into `--help` or docs instead of repeating every run.
- Keep the existing summary line format (`Installed 6, skipped 1 (locally modified).` etc.) and
  the `--force` hint line below the table, unchanged in wording.
- If output is not a TTY (piped/redirected) or `--ascii` is set, keep the same table shape but
  with ASCII status tokens as already implemented (`[OK]` etc.) instead of unicode symbols —
  the tabular layout applies in both modes.

## `morf list` — pivot table: one row per item, one column per tool

Replace the current repeated `*** target ***` / `skills` / `agents` nested headers, AND do NOT
use a flat "one row per target per item" table either (that repeats the same item name once per
tool it's installed in, which is noisy). Instead, pivot: **one row per unique item** (matched by
type + name + source repo), **one column per tool** that has at least one item installed in this
result set, with a status symbol in each cell showing whether that item is installed in that
tool.

```
NAME           TYPE    CLAUDE  CURSOR  KILO  CODEX  WINDSURF  OPENCODE   SOURCE               UPDATED
find-skills    skill     ✓       ✓      ✓     ✓        ✓         ✓      vercel-labs/skills   2026-07-05
pdf-skill      skill     —       —      —     —        —         ✓      …/ray-demo/store     2026-06-20
qa-agent       agent     —       —      —     —        —         ✓      …/ray-demo/store     2026-06-20
```

This directly visualizes morf's core idea (one item, installed across tools) instead of
repeating the item name once per tool.

Rules:
- **Row identity**: group by `(type, name, repoKey)` — the same skill/agent from the same repo
  is ONE row, even if installed into multiple targets. If the same-named item exists from two
  *different* repos, that's two separate rows (disambiguate via the `SOURCE` column, and if
  names collide exactly, append the repo to the `NAME` cell in parentheses so rows are never
  ambiguous).
- **Tool columns**: only include a column for a target if at least one row in this result set
  has something installed there. Someone using only `claude` and `cursor` sees only those two
  tool columns — not all 7. Order tool columns by `listTargets()` order (or by descending count
  of items installed in them — whichever is simpler to implement cleanly).
- **Cell value**: the status symbol for that item in that tool column —
  `✓` installed and current, `↑` update available (only in `--check-updates` mode), `—` not
  installed in that tool at all. Center each symbol within its column width.
- **SOURCE column**: shorten long local filesystem paths — if longer than ~28 characters,
  collapse to `…/<last-two-path-segments>` (e.g.
  `C:/Users/romiv/AppData/Local/Temp/ray-demo/store` → `…/ray-demo/store`). For git URLs, strip
  the `github.com/`/`https://` prefix if not already stripped (so `vercel-labs/skills`, not the
  full URL).
- **UPDATED column**: keep the existing `YYYY-MM-DD` date format. If the same item has different
  install dates per tool (rare but possible), show the most recent one.
- **Sort rows**: by `TYPE` then `NAME`.
- **Header + rule**: one header row, then either a single blank line or a thin `─` rule matching
  the table width — pick whichever reads cleanest; don't introduce a rule character if nothing
  else in the CLI currently uses one.
- **`--check-updates` mode**: cells become three-state (`✓` up to date, `↑` update available,
  `—` not installed there) instead of adding a separate column — the pivot cells already carry
  per-tool status, so update-availability fits naturally into the same cell.
- **`--all-on-disk` unmanaged items**: still fold into the same pivot table. An unmanaged item
  found on disk in some tool but not tracked in the manifest shows a distinct symbol (e.g. `?`)
  in that tool's column instead of `✓`, and its `SOURCE` column shows `(unmanaged)` instead of a
  repo path.
- **Empty result**: keep the existing "No skills or agents managed by morf yet." message — don't
  print an empty table with just headers.
- **Narrow terminals**: if the full pivot table would exceed a reasonable width (many tool
  columns + long names), it's fine to let it wrap/overflow naturally in the terminal — don't
  build responsive truncation logic for this; that's over-engineering for a CLI table.

## Implementation notes

- Put the column-width computation and row-rendering logic in one shared helper (e.g. a new
  `src/table.js`) used by `install.js`, `update.js`, `uninstall.js`, and `list.js` — don't
  duplicate padding math in four files.
- Respect `NO_COLOR` / `--ascii` exactly as today; only the layout changes, not the color/symbol
  logic already in `log.js`.
- Keep it dependency-free (plain string padding — `String.prototype.padEnd`/`padStart` from
  stdlib is enough; no cli-table3 or similar package).
- Update existing tests in `tests/` that assert on the old `*** target ***` header format or the
  old `note:`-on-its-own-line format — they'll need updating to match the new table output. Keep
  the assertions meaningful (check for the right symbol, name, and target appearing in the
  output) rather than brittle exact-string matches on spacing, where reasonable.
- Run the full test suite after the change and confirm it's green.

## What NOT to do

- Don't add heavy box-drawing borders (┌─┬─┐└─┴─┘) — this should read as "aligned columns," not
  "ASCII art box."
- Don't break the live/streaming nature of `install`/`update`/`uninstall` — rows still need to
  appear as work completes, not all at once at the end.
- Don't change the underlying command logic, flags, or manifest format — this is purely an
  output-formatting change.
