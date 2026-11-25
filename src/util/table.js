// Minimal aligned-table helpers shared by install / update / uninstall / list.
//
// Deliberately dependency-free and un-decorated: no box-drawing, just padded
// columns and a dim header row. Widths are measured on *visible* text so ANSI
// color escapes never throw off alignment.

import { log, printable } from './log.js';

// eslint-disable-next-line no-control-regex
const ANSI =/\x1b\[[0-9;]*m/g;

export function visibleWidth(str) {
  return String(str).replace(ANSI, '').length;
}

export function padEndV(str, width) {
  return String(str) + ' '.repeat(Math.max(0, width - visibleWidth(str)));
}

export function padStartV(str, width) {
  return ' '.repeat(Math.max(0, width - visibleWidth(str))) + String(str);
}

// Center visible text within a column, biasing extra space to the right.
export function centerV(str, width) {
  const pad = Math.max(0, width - visibleWidth(str));
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + String(str) + ' '.repeat(pad - left);
}

// ── streaming target table (install / update / uninstall) ─────────────────────
//
// Column widths are computed once up front from the known target + item names,
// then rows are printed live as each result completes — the header appears once
// before the first row, not buffered to the end.
//
//   TARGET      NAME           STATUS
//   claude      find-skills    ✓
//   cursor      find-skills    ✓   (project-scoped)
//
// `tag` is a colored status symbol (e.g. log.TAG.ok()); `note` is an optional
// short dimmed fragment printed on the same row after the status.
export function createTargetTable(targets, names, { indent = '  ', gap = 2 } = {}) {
  const targetW = Math.max('TARGET'.length, ...targets.map(t => printable(t).length)) + gap;
  const nameW   = Math.max('NAME'.length, ...names.map(n => printable(n).length)) + gap;
  let headerPrinted = false;

  function header() {
    if (headerPrinted) return;
    headerPrinted = true;
    log.dim(indent + padEndV('TARGET', targetW) + padEndV('NAME', nameW) + 'STATUS');
  }

  function row(target, name, tag, note) {
    header();
    // target, name and note may carry text from a repository or a git error;
    // `tag` is morf's own coloured status symbol.
    let line = indent + padEndV(printable(target), targetW) + padEndV(printable(name), nameW) + tag;
    if (note) line += '   ' + log.meta(printable(note));
    console.log(line);
  }

  return { header, row };
}

// ── static column table (list pivot) ──────────────────────────────────────────
//
// columns: [{ header, align }]  align: 'left' | 'center' | 'right' (default left)
// rows:    array of string[] (cells may contain ANSI; widths measured visibly)
//
// Renders a dim header row followed by the data rows, columns separated by `gap`
// spaces. No rule characters — alignment alone carries the structure.
export function renderTable(columns, rows, { indent = '', gap = 2 } = {}) {
  const widths = columns.map((col, i) =>
    Math.max(visibleWidth(col.header), ...rows.map(r => visibleWidth(r[i] ?? '')))
  );

  const sep = ' '.repeat(gap);
  const fmt = (cell, i, isHeader) => {
    const align = isHeader ? 'left' : (columns[i].align || 'left');
    if (align === 'center') return centerV(cell, widths[i]);
    if (align === 'right')  return padStartV(cell, widths[i]);
    return padEndV(cell, widths[i]);
  };

  const headerLine = indent + columns.map((c, i) => fmt(c.header, i, true)).join(sep).replace(/\s+$/, '');
  log.dim(headerLine);
  for (const r of rows) {
    const line = indent + columns.map((c, i) => fmt(r[i] ?? '', i, false)).join(sep).replace(/\s+$/, '');
    console.log(line);
  }
}
