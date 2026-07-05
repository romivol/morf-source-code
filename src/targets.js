import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const home = homedir();

// kind: 'dir'  -> a skill is a whole folder copied to <base>/<name>/
// kind: 'file' -> an agent is a single file copied to <base>/<name><ext>
// null         -> this target does not support this type
//
// scope: 'global'  -> base is under the user's home directory
//        'project' -> base is resolved against the current working directory
//                     (tools like Cursor, Copilot and Windsurf are project-scoped)

function windsurfRoot(cwd) {
  // Windsurf rebranded to Devin Desktop (June 2026). Prefer the new `.devin/`
  // directory; fall back to `.windsurf/` only when it already exists in the
  // project and `.devin/` does not.
  const devin = join(cwd, '.devin');
  const legacy = join(cwd, '.windsurf');
  if (!existsSync(devin) && existsSync(legacy)) return legacy;
  return devin;
}

export function getTargets(cwd = process.cwd()) {
  return {
    opencode: {
      displayName: 'OpenCode',
      scope: 'global',
      types: {
        skill: { kind: 'dir',  base: join(home, '.config', 'opencode', 'skills') },
        agent: { kind: 'file', base: join(home, '.config', 'opencode', 'agent'), ext: '.md' },
        hook:  null,
      },
    },
    claude: {
      displayName: 'Claude Code',
      scope: 'global',
      types: {
        skill: { kind: 'dir',  base: join(home, '.claude', 'skills') },
        agent: { kind: 'file', base: join(home, '.claude', 'agents'), ext: '.md' },
        hook:  { kind: 'dir',  base: join(home, '.claude', 'hooks') },
      },
    },
    kilo: {
      displayName: 'Kilo Code',
      scope: 'global',
      types: {
        skill: { kind: 'dir',  base: join(home, '.kilo', 'skills') },
        agent: { kind: 'file', base: join(home, '.kilo', 'agent'), ext: '.md' },
        hook:  null,
      },
    },
    cursor: {
      displayName: 'Cursor',
      scope: 'project',
      types: {
        skill: { kind: 'dir',  base: join(cwd, '.cursor', 'skills') },
        agent: { kind: 'file', base: join(cwd, '.cursor', 'rules'), ext: '.mdc' },
        hook:  null,
      },
    },
    copilot: {
      displayName: 'GitHub Copilot',
      scope: 'project',
      types: {
        skill: { kind: 'dir',  base: join(cwd, '.agents', 'skills') },
        agent: { kind: 'file', base: join(cwd, '.github', 'agents'), ext: '.md' },
        hook:  null,
      },
    },
    codex: {
      displayName: 'Codex CLI',
      scope: 'global',
      types: {
        skill: { kind: 'dir', base: join(home, '.codex', 'skills') },
        agent: null,   // Codex has no per-agent file format — skills only
        hook:  null,
      },
    },
    windsurf: {
      displayName: 'Windsurf (Devin)',
      scope: 'project',
      types: {
        skill: { kind: 'dir',  base: join(windsurfRoot(cwd), 'skills') },
        agent: { kind: 'file', base: join(windsurfRoot(cwd), 'rules'), ext: '.md' },
        hook:  null,
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

// 'all' -> every real target; a single concrete target -> [target]
export function expandTargets(target) {
  if (target === ALL_TARGET) return listTargets();
  return [target];
}

export function resolveDestination(target, type, cwd = null) {
  const table = cwd ? getTargets(cwd) : TARGETS;
  const profile = table[target];
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
    throw new Error(
      `${profile.displayName} does not support ${type}s. ` +
        `Try a different --target, or omit this item.`
    );
  }
  return mapping;
}
