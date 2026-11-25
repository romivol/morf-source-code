// Consistent CLI output with optional ANSI color and unicode/ASCII status symbols.
// All output goes through here so it's easy to redirect or silence in tests.

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

// ── symbol mode ───────────────────────────────────────────────────────────────
// Unicode symbols by default; ASCII bracket tokens with --ascii, MORF_ASCII=1,
// or when stdout is not a TTY (logs/CI stay grep-friendly).
let asciiMode = Boolean(process.env.MORF_ASCII) || !process.stdout.isTTY;
export function setAscii(v) { asciiMode = Boolean(v); }
export function isAscii()   { return asciiMode; }

function c(ansi, str) {
  return useColor ? `${ansi}${str}${RESET}` : str;
}

// Status symbols: [unicode, ascii, color]
const SYMBOLS = {
  ok:   ['\u2713', '[OK]',   GREEN ],  // ✓ installed / up to date
  upd:  ['\u2191', '[UPD]',  CYAN  ],  // ↑ updated
  mod:  ['\u2298', '[MOD]',  YELLOW],  // ⊘ skipped, local changes
  miss: ['\u2717', '[MISS]', RED   ],  // ✗ missing / not found
  warn: ['\u00b1', '[!]',    YELLOW],  // ± adapted (conversion applied)
  fail: ['\u2717', '[FAIL]', RED   ],  // ✗ error
};

function sym(name) {
  const [uni, ascii, color] = SYMBOLS[name];
  return c(color, asciiMode ? ascii : uni);
}

export const log = {
  // Central helpers add exactly one space between token and message.
  ok(msg)      { console.log(`${sym('ok')} ${msg}`); },
  miss(msg)    { console.log(`${sym('miss')} ${msg}`); },
  warn(msg)    { console.warn(`${sym('warn')} ${msg}`); },
  err(msg)     { console.error(`${sym('fail')} ${msg}`); },
  info(msg)    { console.log(msg); },
  dim(msg)     { console.log(c(DIM, msg)); },

  // Raw symbols (token only, colored, no padding).
  TAG: {
    ok:   () => sym('ok'),
    upd:  () => sym('upd'),
    mod:  () => sym('mod'),
    miss: () => sym('miss'),
    warn: () => sym('warn'),
    fail: () => sym('fail'),
  },
};

// ── extra log surface used across commands ────────────────────────────────────

log.bold  = (msg) => console.log(c(BOLD, msg));
log.meta  = (str) => c(DIM, str);

// Tint text with a #RRGGBB hex color via truecolor ANSI escape.
// Returns plain text when color is off (non-TTY, NO_COLOR) or hex is malformed.
export function tintWithHex(text, hex) {
  if (!useColor) return text;
  const m = String(hex).match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/i);
  if (!m) return text;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

// ── Spinner ───────────────────────────────────────────────────────────────────
// Braille frames on unicode-capable TTYs; classic |/-\ in ascii mode.

const FRAMES_UNI   = ['\u280b','\u2819','\u2839','\u2838','\u283c','\u2834','\u2826','\u2827'];
const FRAMES_ASCII = ['|', '/', '-', '\\'];
const isTTY = Boolean(process.stdout.isTTY);

export function createSpinner(label) {
  if (!isTTY) {
    process.stdout.write(`${label}\n`);
    return { stop(finalMsg) { if (finalMsg) console.log(finalMsg); } };
  }

  const frames = asciiMode ? FRAMES_ASCII : FRAMES_UNI;
  let i = 0;
  const draw = () => {
    process.stdout.write(`\r${c(CYAN, frames[i % frames.length])} ${label}  `);
    i++;
  };
  draw();
  const timer = setInterval(draw, asciiMode ? 120 : 80);

  return {
    stop(finalMsg) {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
      if (finalMsg) console.log(finalMsg);
    },
  };
}
