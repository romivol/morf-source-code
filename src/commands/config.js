import {
  readConfig, setDefaultRepo, unsetDefaultRepo,
  setDefaultTarget, unsetDefaultTarget,
  addAlias, removeAlias, setConvertTools,
} from '../config.js';
import { isValidTarget, listTargets, ALL_TARGET } from '../targets.js';
import { log } from '../log.js';

const USAGE = `Usage:
  morf config default <tool>       Set the default install target (${listTargets().join(', ')})
  morf config repo <url>           Set the default repo
  morf config alias <@name> <url>  Create a repo shorthand, e.g. @core
  morf config unalias <@name>      Remove an alias
  morf config convert on|off       Toggle agent frontmatter conversion (other primitives always convert)
  morf config unset default|repo   Clear the default target / repo
  morf config list                 Show all saved config`;

export async function configCommand(subArgs) {
  const sub = subArgs[0];

  switch (sub) {
    // ── default target ────────────────────────────────────────────────────
    case 'default': {
      const tool = subArgs[1];
      if (!tool) { log.err('Usage: morf config default <tool>'); process.exit(1); }
      if (!isValidTarget(tool) || tool === ALL_TARGET) {
        log.err(`Unknown tool "${tool}". Valid tools: ${listTargets().join(', ')}.`);
        process.exit(1);
      }
      await setDefaultTarget(tool);
      log.ok(`Default target set to ${tool}`);
      break;
    }

    // ── default repo ──────────────────────────────────────────────────────
    case 'repo':
    case 'set-default': {  // legacy alias
      const repo = subArgs[1];
      if (!repo) { log.err('Usage: morf config repo <url>'); process.exit(1); }
      await setDefaultRepo(repo);
      log.ok(`Default repo set to ${repo}`);
      break;
    }
    case 'get-default': {  // legacy alias
      const cfg = await readConfig();
      log.info(cfg.defaultRepo || '(none)');
      break;
    }

    // ── aliases ───────────────────────────────────────────────────────────
    case 'alias':
    case 'add-alias': {    // legacy alias
      const name = subArgs[1];
      const repo = subArgs[2];
      if (!name || !repo) { log.err('Usage: morf config alias <@name> <url>'); process.exit(1); }
      if (!name.startsWith('@')) {
        log.err('Alias names must start with "@" (e.g. @core).');
        process.exit(1);
      }
      await addAlias(name, repo);
      log.ok(`Alias ${name} -> ${repo}`);
      break;
    }
    case 'unalias':
    case 'remove-alias': { // legacy alias
      const name = subArgs[1];
      if (!name) { log.err('Usage: morf config unalias <@name>'); process.exit(1); }
      const removed = await removeAlias(name);
      if (removed) log.ok(`Alias ${name} removed.`);
      else log.info(`Alias ${name} not set (nothing to do).`);
      break;
    }

    // ── convert toggle ────────────────────────────────────────────────────
    case 'convert': {
      const val = subArgs[1];
      if (val !== 'on' && val !== 'off') {
        log.err('Usage: morf config convert on|off');
        process.exit(1);
      }
      await setConvertTools(val === 'on');
      log.ok(`convert = ${val}`);
      break;
    }
    case 'set': {          // legacy: config set convert-tools true|false
      const key = subArgs[1];
      const val = subArgs[2];
      if (key === 'convert-tools' && (val === 'true' || val === 'false')) {
        await setConvertTools(val === 'true');
        log.ok(`convert-tools = ${val}`);
      } else {
        log.err(`Unknown config key: ${key || '(none)'}. See: morf config`);
        process.exit(1);
      }
      break;
    }

    // ── unset ─────────────────────────────────────────────────────────────
    case 'unset': {
      const what = subArgs[1];
      if (what === 'default') {
        const cfg = await readConfig();
        if (!cfg.defaultTarget) { log.info('No default target set (nothing to do).'); return; }
        await unsetDefaultTarget();
        log.ok('Default target unset.');
      } else if (what === 'repo') {
        const cfg = await readConfig();
        if (!cfg.defaultRepo) { log.info('No default repo set (nothing to do).'); return; }
        await unsetDefaultRepo();
        log.ok('Default repo unset.');
      } else {
        log.err('Usage: morf config unset default|repo');
        process.exit(1);
      }
      break;
    }
    case 'unset-default': { // legacy alias (repo)
      const cfg = await readConfig();
      if (!cfg.defaultRepo) { log.info('No default repo set (nothing to do).'); return; }
      await unsetDefaultRepo();
      log.ok('Default repo unset.');
      break;
    }

    // ── list ──────────────────────────────────────────────────────────────
    case 'list': {
      const cfg = await readConfig();
      const aliasKeys = Object.keys(cfg.aliases || {});
      log.info(`defaultTarget: ${cfg.defaultTarget || '(none — opencode is used)'}`);
      log.info(`defaultRepo:   ${cfg.defaultRepo || '(none)'}`);
      for (const [k, v] of Object.entries(cfg.aliases || {})) {
        log.info(`alias ${k}: ${v}`);
      }
      log.info(`convert:       ${cfg.convertTools !== false ? 'on' : 'off'}`);
      if (!cfg.defaultTarget && !cfg.defaultRepo && aliasKeys.length === 0) {
        log.dim("  (tip: run 'morf config default <tool>' to set your primary tool)");
      }
      break;
    }

    default: {
      if (sub) log.err(`Unknown config subcommand: ${sub}`);
      log.info(USAGE);
      if (sub) process.exit(1);
    }
  }
}
