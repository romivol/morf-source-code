import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const home = homedir();

// Each target maps every primitive type to where and how it is stored, or to
// null when the tool has no equivalent.
//
// kind: 'dir'   -> a whole folder copied to <base>/<name>/                (skills)
// kind: 'file'  -> one file written to <base>/<prefix><name><ext>
//                  optional `register: { file, key }` also lists the file's path
//                  in a JSON array (opencode/kilo load rules via "instructions")
// kind: 'json'  -> merged into a shared JSON config `file` under `path`
//                  mode 'entry': one object keyed by the item name (MCP servers)
//                  mode 'hooks': { Event: [entries] } lists appended per event
//                  `init` seeds a newly created file (e.g. { version: 1 })
// kind: 'block' -> a marker-delimited block inside a shared text `file`
//                  style 'toml' (# markers) or 'md' (<!-- --> markers)
//
// scope: 'global'  -> under the user's home directory
//        'project' -> resolved against the current working directory
//
// detect: paths whose existence means "this tool is in use here".

function windsurfRoot(cwd) {
  // Windsurf became Devin Desktop (June 2026). Prefer the new `.devin/`
  // directory; fall back to `.windsurf/` only when it already exists in the
  // project and `.devin/` holds no content of its own. Hooks and MCP config
  // always live in `.devin/` (legacy Cascade has no equivalent files), so their
  // presence alone must not flip a legacy project over to `.devin/`.
  const devin = join(cwd, '.devin');
  const legacy = join(cwd, '.windsurf');
  const devinInUse = ['skills', 'rules', 'agents', 'workflows']
    .some(d => existsSync(join(devin, d)));
  if (!devinInUse && existsSync(legacy)) return legacy;
  return devin;
}

// First existing candidate, else the first one (the file morf will create).
function pickExisting(dir, names) {
  for (const n of names) {
    if (existsSync(join(dir, n))) return join(dir, n);
  }
  return join(dir, names[0]);
}

export function getTargets(cwd = process.cwd()) {
  const ocDir = join(home, '.config', 'opencode');
  const ocConfig = pickExisting(ocDir, ['opencode.json', 'opencode.jsonc']);
  const kiloDir = join(home, '.kilo');
  const kiloConfig = pickExisting(join(home, '.config', 'kilo'), ['kilo.jsonc', 'kilo.json']);
  const wsRoot = windsurfRoot(cwd);
  const wsLegacy = wsRoot.endsWith('.windsurf');
  const devin = join(cwd, '.devin');

  return {
    opencode: {
      displayName: 'OpenCode',
      scope: 'global',
      detect: [ocDir],
      types: {
        skill:  { kind: 'dir',  base: join(ocDir, 'skills') },
        agent:  { kind: 'file', base: join(ocDir, 'agent'), ext: '.md' },
        rule:   { kind: 'file', base: join(ocDir, 'rules'), ext: '.md',
                  register: { file: ocConfig, key: 'instructions' } },
        prompt: { kind: 'file', base: join(ocDir, 'commands'), ext: '.md' },
        hook:   { kind: 'file', base: join(ocDir, 'plugins'), prefix: 'morf-', ext: '.js' },
        mcp:    { kind: 'json', file: ocConfig, path: ['mcp'], mode: 'entry' },
      },
    },
    claude: {
      displayName: 'Claude Code',
      scope: 'global',
      detect: [join(home, '.claude')],
      types: {
        skill:  { kind: 'dir',  base: join(home, '.claude', 'skills') },
        agent:  { kind: 'file', base: join(home, '.claude', 'agents'), ext: '.md' },
        rule:   { kind: 'file', base: join(home, '.claude', 'rules'), ext: '.md' },
        prompt: { kind: 'file', base: join(home, '.claude', 'commands'), ext: '.md' },
        hook:   { kind: 'json', file: join(home, '.claude', 'settings.json'), path: ['hooks'], mode: 'hooks' },
        mcp:    { kind: 'json', file: join(home, '.claude.json'), path: ['mcpServers'], mode: 'entry' },
      },
    },
    kilo: {
      displayName: 'Kilo Code',
      scope: 'global',
      detect: [kiloDir, join(home, '.config', 'kilo')],
      types: {
        skill:  { kind: 'dir',  base: join(kiloDir, 'skills') },
        agent:  { kind: 'file', base: join(kiloDir, 'agent'), ext: '.md' },
        rule:   { kind: 'file', base: join(kiloDir, 'rules'), ext: '.md',
                  register: { file: kiloConfig, key: 'instructions' } },
        prompt: { kind: 'file', base: join(kiloDir, 'commands'), ext: '.md' },
        hook:   { kind: 'file', base: join(kiloDir, 'plugins'), prefix: 'morf-', ext: '.js' },
        mcp:    { kind: 'json', file: kiloConfig, path: ['mcp'], mode: 'entry' },
      },
    },
    cursor: {
      displayName: 'Cursor',
      scope: 'project',
      detect: [join(cwd, '.cursor')],
      types: {
        skill:  { kind: 'dir',  base: join(cwd, '.cursor', 'skills') },
        agent:  { kind: 'file', base: join(cwd, '.cursor', 'agents'), ext: '.md',
                  previous: { base: join(cwd, '.cursor', 'rules'), ext: '.mdc' } },
        rule:   { kind: 'file', base: join(cwd, '.cursor', 'rules'), ext: '.mdc' },
        prompt: { kind: 'file', base: join(cwd, '.cursor', 'commands'), ext: '.md' },
        hook:   { kind: 'json', file: join(cwd, '.cursor', 'hooks.json'), path: ['hooks'], mode: 'hooks',
                  init: { version: 1 } },
        mcp:    { kind: 'json', file: join(cwd, '.cursor', 'mcp.json'), path: ['mcpServers'], mode: 'entry' },
      },
    },
    copilot: {
      displayName: 'GitHub Copilot',
      scope: 'project',
      detect: [
        join(cwd, '.github', 'copilot-instructions.md'),
        join(cwd, '.github', 'agents'),
        join(cwd, '.github', 'instructions'),
        join(cwd, '.github', 'prompts'),
        join(cwd, '.github', 'hooks'),
        join(cwd, '.github', 'skills'),
      ],
      types: {
        skill:  { kind: 'dir',  base: join(cwd, '.agents', 'skills') },
        agent:  { kind: 'file', base: join(cwd, '.github', 'agents'), ext: '.md' },
        rule:   { kind: 'file', base: join(cwd, '.github', 'instructions'), ext: '.instructions.md' },
        prompt: { kind: 'file', base: join(cwd, '.github', 'prompts'), ext: '.prompt.md' },
        hook:   { kind: 'file', base: join(cwd, '.github', 'hooks'), ext: '.json' },
        mcp:    { kind: 'json', file: join(cwd, '.mcp.json'), path: ['mcpServers'], mode: 'entry' },
      },
    },
    codex: {
      displayName: 'Codex CLI',
      scope: 'global',
      detect: [join(home, '.codex')],
      types: {
        skill:  { kind: 'dir',  base: join(home, '.codex', 'skills') },
        agent:  { kind: 'file', base: join(home, '.codex', 'agents'), ext: '.toml' },
        // Codex has no rule files: instructions live in AGENTS.md.
        rule:   { kind: 'block', file: join(home, '.codex', 'AGENTS.md'), style: 'md' },
        prompt: { kind: 'file', base: join(home, '.codex', 'prompts'), ext: '.md' },
        hook:   { kind: 'json', file: join(home, '.codex', 'hooks.json'), path: ['hooks'], mode: 'hooks' },
        mcp:    { kind: 'block', file: join(home, '.codex', 'config.toml'), style: 'toml' },
      },
    },
    windsurf: {
      displayName: 'Windsurf (Devin)',
      scope: 'project',
      detect: [devin, join(cwd, '.windsurf'), join(cwd, '.windsurfrules')],
      types: {
        skill:  { kind: 'dir',  base: join(wsRoot, 'skills') },
        // Devin has native subagents; legacy .windsurf/ (Cascade) only has rules.
        agent:  wsLegacy
          ? { kind: 'file', base: join(wsRoot, 'rules'), ext: '.md', asRule: true }
          : { kind: 'file', base: join(wsRoot, 'agents'), ext: '.md',
              previous: { base: join(wsRoot, 'rules'), ext: '.md' } },
        rule:   { kind: 'file', base: join(wsRoot, 'rules'), ext: '.md' },
        prompt: { kind: 'file', base: join(wsRoot, 'workflows'), ext: '.md' },
        hook:   { kind: 'json', file: join(devin, 'hooks.v1.json'), path: [], mode: 'hooks' },
        mcp:    { kind: 'json', file: join(devin, 'mcp_config.json'), path: ['mcpServers'], mode: 'entry' },
      },
    },
  };
}

// Static snapshot for the common case (cwd at import time).
export const TARGETS = getTargets();

export const DEFAULT_TARGET = 'opencode';
export const ALL_TARGET = 'all';

export function isValidTarget(target) {
  return Object.prototype.hasOwnProperty.call(TARGETS, target) || target === ALL_TARGET;
}

export function listTargets() {
  return Object.keys(TARGETS);
}

export function targetScope(target) {
  const t = TARGETS[target];
  return t ? t.scope : null;
}

// Tools that appear to be in use: global tools whose config directory exists
// under the home directory, project tools with a marker in `cwd`.
export function detectTargets(scope = null) {
  const table = tableFor(scope);
  return Object.keys(table).filter(name => table[name].detect.some(p => existsSync(p)));
}

// Accepts a single target, an array of targets, or null/undefined.
// 'all' anywhere -> every real target. Otherwise expands to the concrete
// targets given, de-duplicated while preserving first-seen order.
export function expandTargets(target) {
  const list = Array.isArray(target)
    ? target
    : (target == null ? [] : [target]);
  if (list.includes(ALL_TARGET)) return listTargets();
  return [...new Set(list)];
}

// ── project mode ──────────────────────────────────────────────────────────────
//
// Inside a morf project (a directory with morf.json) every tool installs into
// its project-level directory under the project root; nothing is written under
// the home directory. Cursor, Copilot and Windsurf are project-scoped already,
// so they reuse the entries above; the four global tools get project paths here.
//
// `shared: true` marks a destination that more than one tool reads (and morf
// writes once): `.agents/skills/` for Codex and Copilot, `.mcp.json` for
// Claude Code and Copilot. Ownership of such an item is counted per tool.
//
// `register.relativeTo` makes the registered path relative, so the committed
// config file never contains an absolute path.
export function getProjectTargets(root) {
  const base = getTargets(root);
  const ocConfig = pickExisting(root, ['opencode.json', 'opencode.jsonc']);
  const kiloConfig = pickExisting(root, ['kilo.jsonc', 'kilo.json']);
  const sharedMcp = { kind: 'json', file: join(root, '.mcp.json'), path: ['mcpServers'], mode: 'entry', shared: true };
  const sharedSkills = { kind: 'dir', base: join(root, '.agents', 'skills'), shared: true };

  return {
    opencode: {
      ...base.opencode,
      scope: 'project',
      detect: [join(root, '.opencode'), join(root, 'opencode.json'), join(root, 'opencode.jsonc')],
      types: {
        skill:  { kind: 'dir',  base: join(root, '.opencode', 'skills') },
        agent:  { kind: 'file', base: join(root, '.opencode', 'agents'), ext: '.md' },
        rule:   { kind: 'file', base: join(root, '.opencode', 'rules'), ext: '.md',
                  register: { file: ocConfig, key: 'instructions', relativeTo: root } },
        prompt: { kind: 'file', base: join(root, '.opencode', 'commands'), ext: '.md' },
        hook:   { kind: 'file', base: join(root, '.opencode', 'plugins'), prefix: 'morf-', ext: '.js' },
        mcp:    { kind: 'json', file: ocConfig, path: ['mcp'], mode: 'entry' },
      },
    },
    claude: {
      ...base.claude,
      scope: 'project',
      detect: [join(root, '.claude'), join(root, 'CLAUDE.md')],
      types: {
        skill:  { kind: 'dir',  base: join(root, '.claude', 'skills') },
        agent:  { kind: 'file', base: join(root, '.claude', 'agents'), ext: '.md' },
        rule:   { kind: 'file', base: join(root, '.claude', 'rules'), ext: '.md' },
        prompt: { kind: 'file', base: join(root, '.claude', 'commands'), ext: '.md' },
        hook:   { kind: 'json', file: join(root, '.claude', 'settings.json'), path: ['hooks'], mode: 'hooks' },
        mcp:    sharedMcp,
      },
    },
    kilo: {
      ...base.kilo,
      scope: 'project',
      detect: [join(root, '.kilo'), join(root, 'kilo.jsonc'), join(root, 'kilo.json')],
      types: {
        skill:  { kind: 'dir',  base: join(root, '.kilo', 'skills') },
        agent:  { kind: 'file', base: join(root, '.kilo', 'agents'), ext: '.md' },
        rule:   { kind: 'file', base: join(root, '.kilo', 'rules'), ext: '.md',
                  register: { file: kiloConfig, key: 'instructions', relativeTo: root } },
        prompt: { kind: 'file', base: join(root, '.kilo', 'commands'), ext: '.md' },
        hook:   { kind: 'file', base: join(root, '.kilo', 'plugins'), prefix: 'morf-', ext: '.js' },
        mcp:    { kind: 'json', file: kiloConfig, path: ['mcp'], mode: 'entry' },
      },
    },
    cursor: base.cursor,
    copilot: {
      ...base.copilot,
      types: { ...base.copilot.types, skill: sharedSkills, mcp: sharedMcp },
    },
    codex: {
      ...base.codex,
      scope: 'project',
      detect: [join(root, '.codex')],
      types: {
        skill:  sharedSkills,
        agent:  { kind: 'file', base: join(root, '.codex', 'agents'), ext: '.toml' },
        rule:   { kind: 'block', file: join(root, 'AGENTS.md'), style: 'md' },
        prompt: null,
        hook:   { kind: 'json', file: join(root, '.codex', 'hooks.json'), path: ['hooks'], mode: 'hooks' },
        mcp:    { kind: 'block', file: join(root, '.codex', 'config.toml'), style: 'toml' },
      },
      unsupported: { prompt: 'codex has no project-level prompts' },
    },
    windsurf: base.windsurf,
  };
}

// Tools that read the project's root AGENTS.md as always-on instructions.
// A rule installed for Codex (which has nowhere else to put it) is therefore
// also seen by these tools.
export const READS_ROOT_AGENTS_MD = ['opencode', 'kilo', 'cursor', 'copilot', 'windsurf'];

// The storage table for a scope: null/undefined = today's global behaviour,
// { project: root } = project mode, a string = legacy "cwd" form.
export function tableFor(scope) {
  if (!scope) return TARGETS;
  if (typeof scope === 'string') return getTargets(scope);
  return getProjectTargets(scope.project);
}

// True when `target` has a destination for `type`.
export function supportsType(target, type, scope = null) {
  const profile = tableFor(scope)[target];
  return Boolean(profile && profile.types[type]);
}

export function resolveDestination(target, type, scope = null) {
  const profile = tableFor(scope)[target];
  if (!profile) {
    throw new Error(
      `Unknown target "${target}". Valid targets: ${listTargets().join(', ')}.`
    );
  }
  const mapping = profile.types[type];
  if (mapping === undefined) {
    throw new Error(`Unknown type "${type}".`);
  }
  if (mapping === null) {
    const reason = profile.unsupported && profile.unsupported[type];
    const err = new Error(
      `${profile.displayName} does not support ${type}s${reason ? ` (${reason})` : ''}. ` +
        `Try a different --target, or omit this item.`
    );
    err.unsupported = reason || `not supported by ${target}`;
    throw err;
  }
  return mapping;
}
