import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { installCommand } from './commands/install.js';
import { updateCommand } from './commands/update.js';
import { uninstallCommand } from './commands/uninstall.js';
import { listCommand } from './commands/list.js';
import { configCommand } from './commands/config.js';
import { isValidTarget, listTargets, detectTargets, targetScope, DEFAULT_TARGET, ALL_TARGET } from './targets.js';
import { TYPES } from './scan.js';
import { readConfig } from './config.js';
import { log, setAscii } from './log.js';
import { err as E } from './messages.js';
import { printBanner } from './banner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// --<flag> -> primitive type. --command is an alias for --prompt.
const TYPE_FLAGS = { '--command': 'prompt' };
for (const t of TYPES) TYPE_FLAGS[`--${t}`] = t;

const TYPE_FLAG_LIST = TYPES.map(t => `--${t}`).join('|');
const byScope = scope => listTargets().filter(t => targetScope(t) === scope).join(', ');

const HELP = `
morf — one agent, every tool.
Install and convert AI skills, agents, rules, prompts, hooks and MCP servers
for ${listTargets().join(', ')}.

Usage:
  morf install   [<repo>] [${TYPE_FLAG_LIST} <name>...] [--all]
                          [--target <tool>...|all] [--ref <branch>] [--force] [--dry-run]
  morf update    [${TYPE_FLAG_LIST} <name>...] [--all]
                          [--target <tool>...|all] [--ref <branch>] [--force] [--dry-run]
  morf uninstall [${TYPE_FLAG_LIST} <name>...] [--all]
                          [--target <tool>...|all] [--force | -y] [--dry-run]
  morf list      [--all] [--check-updates] [--target <tool>...|all]
  morf config    <subcommand>   (run 'morf config' for details)
  morf --help | -h
  morf --version | -v

Tools:
  ${listTargets().join(' · ')}
  Global-scope: ${byScope('global')} (installed under your home directory)
  Project-scope: ${byScope('project')} (installed into the current project)

Flags:
  --skill <name>    Skill(s) to act on (repeatable or space-separated)
  --agent <name>    Agent(s) to act on
  --rule <name>     Rule(s) to act on
  --prompt <name>   Prompt(s) / slash command(s) to act on (alias: --command)
  --hook <name>     Hook set(s) to act on
  --mcp <name>      MCP server(s) to act on
  --all             Everything in the repo (install; the default when nothing is named)
                    or everything already managed (update/uninstall)
  --target <t>      Which tool(s) (repeatable or space-separated; 'all' for every tool).
                    install defaults to your configured tool, else every tool detected
                    on this machine and in this project, else ${DEFAULT_TARGET}.
                    update/uninstall default to every tool the item is installed in.
  --ref <branch>    Branch or tag to clone from (remembered for later updates)
  --force / -y      Overwrite local edits (install/update); skip confirm prompt (uninstall)
  --dry-run         Show what would happen without writing anything
  --ascii           Use ASCII status tokens instead of unicode symbols
  --all             (list) Also show unmanaged items found on disk (alias: --all-on-disk)
  --check-updates   (list) Check each repo for a newer version

Examples:
  morf install github.com/my-org/skills        # everything, into every detected tool
  morf config default claude
  morf config repo github.com/my-org/skills.git
  morf config alias @core github.com/my-org/skills.git
  morf install @core --all
  morf install @core --skill pdf-skill code-review --agent qa-agent --target claude
  morf install @core --agent bug-finder --target claude opencode codex
  morf install @core --agent bug-finder --target all      # every tool at once
  morf install @core --mcp github --hook format-on-save --target claude cursor
  morf update --all
  morf uninstall --skill pdf-skill -y

Everything except skills is converted to each tool's native format on install
(frontmatter, tools, permissions, event names, config shape). Agent frontmatter
conversion can be turned off with: morf config convert off

Tip: git must be installed on your machine (not via npm).
Tip: dry-run still clones the repo so the preview reflects reality.
`.trim();

export async function run(argv) {
  let args = argv.slice(2);

  // Global --ascii flag (anywhere on the command line).
  if (args.includes('--ascii')) {
    setAscii(true);
    args = args.filter(a => a !== '--ascii');
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printBanner();
    log.info(HELP);
    return;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    log.info(pkg.version);
    return;
  }

  const command = args[0];

  if (command === 'list') {
    const rest = args.slice(1);
    const allOnDisk = rest.includes('--all-on-disk') || rest.includes('--all');
    const checkUpdates = rest.includes('--check-updates');
    const listTargets_ = [];
    const ti = rest.indexOf('--target');
    if (ti !== -1) {
      let j = ti + 1;
      let consumed = 0;
      while (j < rest.length && !rest[j].startsWith('-')) {
        const val = rest[j];
        if (!isValidTarget(val)) {
          log.err(`Unknown target "${val}". Valid targets: ${listTargets().join(', ')}, all.`);
          process.exit(1);
        }
        listTargets_.push(val); j++; consumed++;
      }
      if (consumed === 0) { log.err('--target requires a value.'); process.exit(1); }
    }
    // 'all' (or no --target) means no filter.
    const listTarget = listTargets_.includes(ALL_TARGET) ? null : listTargets_;
    await listCommand({ allOnDisk, target: listTarget, checkUpdates });
    return;
  }

  if (command === 'config') {
    await configCommand(args.slice(1));
    return;
  }

  if (command === 'install') {
    const parsed = await parseInstallArgs(args.slice(1), 'install', { acceptRepo: true, acceptDashY: false });
    if (!parsed) return;
    await installCommand(parsed);
    return;
  }

  if (command === 'update') {
    const parsed = await parseInstallArgs(args.slice(1), 'update', { acceptRepo: false, acceptDashY: false });
    if (!parsed) return;
    await updateCommand(parsed);
    return;
  }

  if (command === 'uninstall') {
    const parsed = await parseInstallArgs(args.slice(1), 'uninstall', { acceptRepo: true, acceptDashY: true });
    if (!parsed) return;
    await uninstallCommand(parsed);
    return;
  }

  log.err(`Unknown command: ${command}`);
  log.info(HELP);
  process.exit(1);
}

async function parseInstallArgs(args, command, { acceptRepo, acceptDashY }) {
  let repoArg = null;
  let i = 0;
  if (acceptRepo && args[0] && !args[0].startsWith('-')) {
    repoArg = args[0];
    i = 1;
  }

  const names = Object.fromEntries(TYPES.map(t => [t, []]));
  const targets = [];          // resolved below: flag > config > detected > DEFAULT_TARGET
  let all = false;
  let targetFromFlag = false;
  let force = false;
  let ref = null;
  let dryRun = false;

  for (; i < args.length; i++) {
    const a = args[i];
    if (Object.prototype.hasOwnProperty.call(TYPE_FLAGS, a)) {
      const type = TYPE_FLAGS[a];
      i++;
      let consumed = 0;
      while (i < args.length && !args[i].startsWith('-')) { names[type].push(args[i]); i++; consumed++; }
      i--;
      if (consumed === 0) { log.err(`${a} requires a name.`); process.exit(1); return null; }
    } else if (a === '--all') {
      all = true;
    } else if (a === '--target') {
      i++;
      let consumed = 0;
      while (i < args.length && !args[i].startsWith('-')) {
        const val = args[i];
        if (!isValidTarget(val)) {
          log.err(`Unknown target "${val}". Valid targets: ${listTargets().join(', ')}, all.`);
          process.exit(1);
          return null;
        }
        targets.push(val); i++; consumed++;
      }
      i--;
      if (consumed === 0) { log.err('--target requires a value.'); process.exit(1); return null; }
      targetFromFlag = true;
    } else if (a === '--force' || (acceptDashY && a === '-y')) {
      force = true;
    } else if (a === '--ref') {
      const val = args[++i];
      if (!val || val.startsWith('-')) { log.err('--ref requires a branch or tag name.'); process.exit(1); return null; }
      ref = val;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else {
      log.err(`Unknown option: ${a}`);
      log.info(HELP);
      process.exit(1);
      return null;
    }
  }

  // Default target for install: CLI flag > configured default > every detected
  // tool > built-in default. 'update' and 'uninstall' keep an empty list when no
  // flag is given: they act on whatever is managed, in every tool.
  if (!targetFromFlag && command === 'install') {
    const cfg = await readConfig();
    if (cfg.defaultTarget && isValidTarget(cfg.defaultTarget)) {
      targets.push(cfg.defaultTarget);
    } else {
      const detected = detectTargets();
      if (detected.length > 0) {
        targets.push(...detected);
        log.dim(`detected ${detected.join(', ')} — installing into ${detected.length === 1 ? 'it' : 'each'}. ` +
                `Pin one with: morf config default <tool>`);
      } else {
        targets.push(DEFAULT_TARGET);
        log.dim(`no tool detected and no default configured — using ${DEFAULT_TARGET}. ` +
                `Set yours with: morf config default <tool>`);
      }
    }
  }

  const named = TYPES.some(t => names[t].length > 0);

  if (all && named) {
    log.err(E.allWithNamed);
    process.exit(1);
    return null;
  }

  if (!all && !named) {
    // Zero-config install: a bare 'morf install <repo>' installs everything.
    if (command === 'install') {
      all = true;
    } else {
      log.err(`Usage: morf ${command} --all | --skill <name> ... (also ${TYPES.slice(1).map(t => `--${t}`).join(', ')})`);
      process.exit(1);
      return null;
    }
  }

  return { repoArg, names, all, targets, force, ref, dryRun };
}
