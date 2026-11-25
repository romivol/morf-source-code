// morf init: create an empty project file.
//
// Returns an exit code (0 or 1) and never calls process.exit; the terminal
// comes through ctx.io, so the command can be tested without a real TTY.
//
//   ctx: { root, cwd, io, morfVersion }

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { PROJECT_FILE, emptyProject, writeProjectFile } from '../project/project-file-and-lockfile.js';
import { log } from '../util/log.js';
import { project as P } from '../util/messages.js';

export async function initCommand(ctx) {
  const path = join(ctx.cwd, PROJECT_FILE);
  if (existsSync(path)) {
    log.err(P.initExists(path));
    return 1;
  }
  await writeProjectFile(ctx.cwd, emptyProject());
  log.ok(P.initDone(path));
  return 0;
}
