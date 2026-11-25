// ~/.morf/config.json — optional config: default repo, default target, aliases.
// All I/O is resilient: missing or corrupt file -> empty config, never crash.
// A legacy ~/.ray/config.json is migrated silently on first read.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureDir } from './fs.js';
import { err as E } from './messages.js';
import { assertSafeRepo } from '../repo/validate.js';

const CONFIG_DIR  = join(homedir(), '.morf');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const LEGACY_PATH = join(homedir(), '.ray', 'config.json');

const EMPTY_CONFIG = () => ({ defaultRepo: null, defaultTarget: null, aliases: {}, convertTools: true });

function shapeConfig(parsed) {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('bad shape');
  return {
    defaultRepo:   typeof parsed.defaultRepo   === 'string' ? parsed.defaultRepo   : null,
    defaultTarget: typeof parsed.defaultTarget === 'string' ? parsed.defaultTarget : null,
    aliases: parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
    convertTools: typeof parsed.convertTools === 'boolean' ? parsed.convertTools : true,
  };
}

export async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return shapeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // One-time silent migration from the legacy ~/.ray config.
      try {
        const legacy = shapeConfig(JSON.parse(await fs.readFile(LEGACY_PATH, 'utf8')));
        await writeConfig(legacy);
        return legacy;
      } catch { /* no legacy config either */ }
    }
    return EMPTY_CONFIG();
  }
}

export async function writeConfig(config) {
  await ensureDir(CONFIG_DIR);
  try {
    JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      await fs.rename(CONFIG_PATH, CONFIG_PATH + '.bak.' + Date.now()).catch(() => {});
    }
  }
  const tmp = CONFIG_PATH + '.tmp.' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
}

// The repo a command should use: the argument, an @alias, or the configured
// default. Whichever it is, it is validated here, before any caller can hand
// it to git.
export function resolveRepo(repoArg, config) {
  let repo;
  if (repoArg && repoArg.startsWith('@')) {
    repo = (config.aliases || {})[repoArg];
    if (!repo) throw new Error(E.unknownAlias(repoArg, Object.keys(config.aliases || {})));
  } else if (repoArg) {
    repo = repoArg;
  } else if (config.defaultRepo) {
    repo = config.defaultRepo;
  } else {
    throw new Error(E.noRepo);
  }
  return assertSafeRepo(repo, { commandLine: true });
}

export async function setDefaultRepo(repo) {
  const cfg = await readConfig();
  cfg.defaultRepo = repo;
  await writeConfig(cfg);
}

export async function unsetDefaultRepo() {
  const cfg = await readConfig();
  cfg.defaultRepo = null;
  await writeConfig(cfg);
}

export async function setDefaultTarget(target) {
  const cfg = await readConfig();
  cfg.defaultTarget = target;
  await writeConfig(cfg);
}

export async function unsetDefaultTarget() {
  const cfg = await readConfig();
  cfg.defaultTarget = null;
  await writeConfig(cfg);
}

export async function addAlias(name, repo) {
  const cfg = await readConfig();
  if (!cfg.aliases) cfg.aliases = {};
  cfg.aliases[name] = repo;
  await writeConfig(cfg);
}

export async function removeAlias(name) {
  const cfg = await readConfig();
  if (!cfg.aliases || !cfg.aliases[name]) return false;
  delete cfg.aliases[name];
  await writeConfig(cfg);
  return true;
}

export async function setConvertTools(value) {
  const cfg = await readConfig();
  cfg.convertTools = Boolean(value);
  await writeConfig(cfg);
}
