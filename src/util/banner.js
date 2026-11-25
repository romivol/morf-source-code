import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadLines(file) {
  return readFileSync(join(__dirname, 'assets', file), 'utf8')
    .split('\n')
    .filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
}

export function printBanner() {
  const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  const magenta = s => useColor ? `\x1b[35m${s}\x1b[0m` : s;
  const cyan    = s => useColor ? `\x1b[36m${s}\x1b[0m` : s;
  const bold    = s => useColor ? `\x1b[1m${s}\x1b[0m`  : s;
  const dim     = s => useColor ? `\x1b[2m${s}\x1b[0m`  : s;

  const lines = loadLines('banner-morf.txt');
  lines.forEach((line, i) => {
    // First line is the morph shapes: violet -> cyan; the wordmark stays bold.
    if (i === 0) {
      const half = Math.floor(line.length / 2);
      process.stdout.write(magenta(line.slice(0, half)) + cyan(line.slice(half)) + '\n');
    } else {
      process.stdout.write(bold(line) + '\n');
    }
  });
  process.stdout.write('\n' + dim('one agent, every tool') + '\n\n');
}
