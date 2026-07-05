import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { installCommand } from './commands/install.js';
import { updateCommand } from './commands/update.js';
import { uninstallCommand } from './commands/uninstall.js';
import { listCommand } from './commands/list.js';
import { configCommand } from './commands/config.js';
import { isValidTarget, listTargets, DEFAULT_TARGET, ALL_TARGET } from './targets.js';
import { readConfig } from './config.js';
import { log, setAscii } from './log.js';
import { err as E } from './messages.js';
import { printBanner } from './banner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `
morf — one agent, every tool.
Install and convert AI skills & agents for ${listTargets().join(', ')}.

Usage:
  morf install   [<repo>] [--skill <name>]... [--agent <name>]... [--all]
                          [--target <tool>|all] [--ref <branch>] [--force] [--dry-run]
  morf update    [--skill <name>]... [--agent <name>]... [--all]
                          [--target <tool>|all] [--ref <branch>] [--force] [--dry-run]
  morf uninstall [<repo>] [--skill <name>]... [--agent <name>]... [--all]
                          [--target <tool>|all] [--force | -y] [--dry-run]
  morf list      [--all-on-disk] [--check-updates] [--target <tool>|all]
  morf config    <subcommand>   (run 'morf config' for details)
  morf --help | -h
  morf --version | -v

Tools:
  ${listTargets().join(' \u00b7 ')}
  Global-scope: claude, opencode, kilo (installed under your home directory)
  Project-scope: cursor, copilot, windsurf (installed into the current project)

Flags:
  --skill <name>    Skill to install/update/uninstall (repeatable or space-separated)
  --agent <name>    Agent to install/update/uninstall (repeatable or space-separated)
  --all             All items in the repo (install) or already managed (update/uninstall)
  --target <t>      Where to install (default: your configured tool, else ${DEFAULT_TARGET})
  --ref <branch>    Branch or tag to clone from (saved to the manifest)
  --force / -y      Overwrite local edits (install/update); skip confirm prompt (uninstall)
  --dry-run         Show what would happen without writing anything
  --ascii           Use ASCII status tokens instead of unicode symbols
  --all-on-disk     (list) Also show unmanaged items found on disk
  --check-updates   (list) Check each repo for a newer version

Examples:
  morf config default claude
  morf config repo github.com/my-org/skills.git
  morf config alias @core github.com/my-org/skills.git
  morf install @core --all
  morf install @core --skill pdf-skill code-review --agent qa-agent --target claude
  morf install @core --agent bug-finder --target all      # every tool at once
  morf install @core --agent bug-finder --target cursor   # converted to a .mdc rule
  morf update --all
  morf uninstall --skill pdf-skill -y

Agents are converted to each tool's native format on install (frontmatter,
tools, permissions) — disable with: morf config convert off

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
    const allOnDisk = rest.includes('--all-on-disk');
    const checkUpdates = rest.includes('--check-updates');
    let listTarget = null;
    const ti = rest.indexOf('--target');
    if (ti !== -1) {
      const val = rest[ti + 1];
      if (!val || val.startsWith('-')) { log.err('--target requires a value.'); process.exit(1); }
      if (!isValidTarget(val)) {
        log.err(`Unknown target "${val}". Valid targets: ${listTargets().join(', ')}, all.`);
        process.exit(1);
      }
      listTarget = val === ALL_TARGET ? null : val;
    }
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

  const skills = [];
  const agents = [];
  let all = false;
  let target = null;           // resolved below: flag > config > DEFAULT_TARGET
  let targetFromFlag = false;
  let force = false;
  let ref = null;
  let dryRun = false;

  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--skill') {
      i++;
      let consumed = 0;
      while (i < args.length && !args[i].startsWith('-')) { skills.push(args[i]); i++; consumed++; }
      i--;
      if (consumed === 0) { log.err('--skill requires a name.'); process.exit(1); return null; }
    } else if (a === '--agent') {
      i++;
      let consumed = 0;
      while (i < args.length && !args[i].startsWith('-')) { agents.push(args[i]); i++; consumed++; }
      i--;
      if (consumed === 0) { log.err('--agent requires a name.'); process.exit(1); return null; }
    } else if (a === '--all') {
      all = true;
    } else if (a === '--target') {
      const val = args[++i];
      if (!val || val.startsWith('-')) { log.err('--target requires a value.'); process.exit(1); return null; }
      if (!isValidTarget(val)) {
        log.err(`Unknown target "${val}". Valid targets: ${listTargets().join(', ')}, all.`);
        process.exit(1);
        return null;
      }
      target = val;
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

  // Resolve default target: CLI flag > configured default > built-in default.
  // ('update' keeps null when no flag: it updates whatever is managed.)
  if (!targetFromFlag && command !== 'update') {
    const cfg = await readConfig();
    if (cfg.defaultTarget && isValidTarget(cfg.defaultTarget)) {
      target = cfg.defaultTarget;
    } else {
      target = DEFAULT_TARGET;
      log.dim(`no default tool configured — using ${DEFAULT_TARGET}. ` +
              `Set yours with: morf config default <tool>`);
    }
  }

  if (all && (skills.length > 0 || agents.length > 0)) {
    log.err(E.allWithNamed);
    process.exit(1);
    return null;
  }

  if (!all && skills.length === 0 && agents.length === 0) {
    log.err(`Usage: morf ${command} ${command === 'update' ? '' : '[<repo>] '}--skill <name> ...`);
    process.exit(1);
    return null;
  }

  return { repoArg, skills, agents, all, target, force, ref, dryRun };
}
