// Surgical edits to JSON / JSONC text.
//
// morf shares config files with the user (settings.json, mcp.json, opencode.json,
// kilo.jsonc, ...). It must change only its own entries: every other byte —
// comments, key order, spacing — stays exactly as the user wrote it. So instead
// of parse → modify → re-serialize, these helpers locate a value's character
// span in the original text and splice only that span.
//
// All functions take the document text and return the new text. Empty or
// missing text is treated as an empty object.

import { canonical } from './json-file.js';

const BOM = String.fromCharCode(0xFEFF);

function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === BOM;
}

// Skip whitespace and comments.
function skipWs(text, i) {
  for (;;) {
    while (i < text.length && isWs(text[i])) i++;
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      return i;
    }
  }
}

function stringEnd(text, i) {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  if (j >= text.length) throw new Error('unterminated string');
  return j + 1;
}

// Parse into a tree of nodes carrying character offsets.
//   { type: 'object' | 'array' | 'value', start, end, children? }
//   object children: { key, start, end, value }   array children: { start, end, value }
function parseValue(text, at) {
  const i = skipWs(text, at);
  const ch = text[i];
  if (ch === undefined) throw new Error('unexpected end of input');

  if (ch === '{' || ch === '[') {
    const isObj = ch === '{';
    const close = isObj ? '}' : ']';
    const node = { type: isObj ? 'object' : 'array', start: i, end: -1, children: [] };
    let j = i + 1;
    for (;;) {
      j = skipWs(text, j);
      if (j >= text.length) throw new Error(`missing ${close}`);
      if (text[j] === close) { node.end = j + 1; return node; }
      if (text[j] === ',') { j++; continue; }
      if (isObj) {
        if (text[j] !== '"') throw new Error(`expected a property name at offset ${j}`);
        const keyStart = j;
        const keyEnd = stringEnd(text, j);
        const key = JSON.parse(text.slice(keyStart, keyEnd));
        j = skipWs(text, keyEnd);
        if (text[j] !== ':') throw new Error(`expected ":" at offset ${j}`);
        const value = parseValue(text, j + 1);
        node.children.push({ key, start: keyStart, end: value.end, value });
        j = value.end;
      } else {
        const value = parseValue(text, j);
        node.children.push({ start: value.start, end: value.end, value });
        j = value.end;
      }
    }
  }

  if (ch === '"') return { type: 'value', start: i, end: stringEnd(text, i) };

  let j = i;
  while (j < text.length && !isWs(text[j]) && !',]}/'.includes(text[j])) j++;
  JSON.parse(text.slice(i, j));   // throws on anything that is not a JSON literal
  return { type: 'value', start: i, end: j };
}

function parseRoot(text) {
  const root = parseValue(text, 0);
  if (skipWs(text, root.end) !== text.length) throw new Error('unexpected content after the top-level value');
  if (root.type !== 'object') throw new Error('top-level value is not an object');
  return root;
}

function toData(text, node) {
  if (node.type === 'object') {
    const out = {};
    for (const c of node.children) out[c.key] = toData(text, c.value);
    return out;
  }
  if (node.type === 'array') return node.children.map(c => toData(text, c.value));
  return JSON.parse(text.slice(node.start, node.end));
}

function normalize(text) {
  return text == null || text.trim() === '' ? '{}\n' : text;
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function lineStart(text, pos) {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineIndent(text, pos) {
  const s = lineStart(text, pos);
  let e = s;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(s, e);
}

// Indentation for a new child of `container`.
function childIndent(text, container) {
  const first = container.children[0];
  if (first) {
    const s = lineStart(text, first.start);
    if (text.slice(s, first.start).trim() === '') return text.slice(s, first.start);
  }
  return lineIndent(text, container.start) + '  ';
}

function serialize(value, indent, eol) {
  return JSON.stringify(value, null, 2).split('\n').join(eol + indent);
}

function findNode(text, path) {
  let node = parseRoot(text);
  for (const key of path) {
    if (node.type !== 'object') return null;
    const child = node.children.find(c => c.key === key);
    if (!child) return null;
    node = child.value;
  }
  return node;
}

// Insert a new last child into `container`: a property when `key` is given,
// otherwise an array item.
function insertChild(text, container, key, value) {
  const eol = eolOf(text);
  const closeAt = container.end - 1;
  const parentInd = lineIndent(text, container.start);
  const label = key === null ? '' : JSON.stringify(key) + ': ';

  // A container written on one line stays on one line, so that removing the
  // child again gives back exactly the original text.
  const oneLine = !text.slice(container.start, container.end).includes('\n');
  if (oneLine && container.children.length > 0) {
    const last = container.children[container.children.length - 1];
    const afterLast = skipWs(text, last.end);
    const hasComma = text[afterLast] === ',';
    const inner = text.slice(container.start + 1, closeAt);
    const sp = /,\s/.test(inner) || /^\s/.test(inner) ? ' ' : '';
    const compactLabel = key === null ? '' : JSON.stringify(key) + ':' + (/":\s/.test(inner) ? ' ' : '');
    const child = compactLabel + JSON.stringify(value);
    if (hasComma) return text.slice(0, afterLast + 1) + sp + child + ',' + text.slice(afterLast + 1);
    return text.slice(0, last.end) + ',' + sp + child + text.slice(last.end);
  }

  const ind = childIndent(text, container);
  const childText = label + serialize(value, ind, eol);

  if (container.children.length === 0) {
    const inner = text.slice(container.start + 1, closeAt);
    if (inner.includes('\n')) {
      return text.slice(0, container.start + 1) + eol + ind + childText + text.slice(container.start + 1);
    }
    return text.slice(0, container.start + 1) + eol + ind + childText + eol + parentInd + text.slice(closeAt);
  }

  const last = container.children[container.children.length - 1];
  const afterLast = skipWs(text, last.end);
  const hasComma = text[afterLast] === ',';
  const anchor = hasComma ? afterLast + 1 : last.end;

  // The new child goes on its own line, after anything (a comment) that trails
  // the last child on its line.
  const nl = text.indexOf('\n', anchor);
  if (nl === -1 || nl > closeAt) {
    // The closing bracket shares the last child's line: break the line before it.
    let q = closeAt;
    while (q > anchor && (text[q - 1] === ' ' || text[q - 1] === '\t')) q--;
    return text.slice(0, last.end) + (hasComma ? '' : ',') + text.slice(last.end, q) +
      eol + ind + childText + (hasComma ? ',' : '') + eol + parentInd + text.slice(closeAt);
  }
  const q = text[nl - 1] === '\r' ? nl - 1 : nl;
  return text.slice(0, last.end) + (hasComma ? '' : ',') + text.slice(last.end, q) +
    eol + ind + childText + (hasComma ? ',' : '') + text.slice(q);
}

// Position of the comma between two siblings (skipping comments), or -1.
function commaBetween(text, from, to) {
  let i = from;
  while (i < to) {
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < to && text[i] !== '\n') i++;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? to : end + 2;
    } else if (text[i] === ',') {
      return i;
    } else {
      i++;
    }
  }
  return -1;
}

// Remove child `idx` of `container`, with its separator and its line.
function removeChild(text, container, idx) {
  const c = container.children[idx];
  let start = c.start;
  let end = c.end;
  let extraComma = -1;      // a separator that sits apart from the child's own span

  let k = end;
  while (text[k] === ' ' || text[k] === '\t') k++;
  if (text[k] === ',') {
    end = k + 1;
  } else if (idx > 0) {
    // Last child, no trailing comma: the comma after the previous sibling goes too.
    const comma = commaBetween(text, container.children[idx - 1].end, start);
    if (comma !== -1) {
      if (text.slice(comma + 1, start).trim() === '' && !text.slice(comma, start).includes('\n')) start = comma;
      else extraComma = comma;
    }
  }

  // Alone on its line: take the whole line. Otherwise take the spaces in front.
  const ls = lineStart(text, start);
  let le = end;
  while (text[le] === ' ' || text[le] === '\t') le++;
  if (text[le] === '\r') le++;
  if (text.slice(ls, start).trim() === '' && text[le] === '\n') {
    start = ls;
    end = le + 1;
  } else if (text[start] !== ',') {
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  }

  let out = text.slice(0, start) + text.slice(end);
  if (extraComma !== -1) out = out.slice(0, extraComma) + out.slice(extraComma + 1);
  return out;
}

function nest(keys, value) {
  let v = value;
  for (let i = keys.length - 1; i >= 0; i--) v = { [keys[i]]: v };
  return v;
}

// ── public API ────────────────────────────────────────────────────────────────

// The value at `path` as plain data, or undefined.
export function getPath(text, path) {
  const t = normalize(text);
  const node = findNode(t, path);
  return node ? toData(t, node) : undefined;
}

// Set the value at `path`, creating missing parent objects.
export function setPath(text, path, value) {
  const t = normalize(text);
  const eol = eolOf(t);
  let node = parseRoot(t);
  for (let i = 0; i < path.length; i++) {
    if (node.type !== 'object') throw new Error(`"${path.slice(0, i).join('.')}" is not an object`);
    const child = node.children.find(c => c.key === path[i]);
    if (!child) {
      return insertChild(t, node, path[i], nest(path.slice(i + 1), value));
    }
    if (i === path.length - 1) {
      const ind = lineIndent(t, child.start);
      return t.slice(0, child.value.start) + serialize(value, ind, eol) + t.slice(child.value.end);
    }
    node = child.value;
  }
  throw new Error('setPath needs a non-empty path');
}

// Remove the property at `path`. No-op when it does not exist.
export function removePath(text, path) {
  const t = normalize(text);
  const parent = findNode(t, path.slice(0, -1));
  if (!parent || parent.type !== 'object') return t;
  const idx = parent.children.findIndex(c => c.key === path[path.length - 1]);
  return idx === -1 ? t : removeChild(t, parent, idx);
}

const same = (a, b) => canonical(a) === canonical(b);

// Append `item` to the array at `path` unless an equal item is already there.
// Creates the array (and parents) when missing.
export function arrayAppend(text, path, item) {
  const t = normalize(text);
  const node = findNode(t, path);
  if (!node) return setPath(t, path, [item]);
  if (node.type !== 'array') throw new Error(`"${path.join('.')}" is not an array`);
  if (node.children.some(c => same(toData(t, c.value), item))) return t;
  return insertChild(t, node, null, item);
}

// Remove the first array item equal to `item`. No-op when absent.
export function arrayRemove(text, path, item) {
  const t = normalize(text);
  const node = findNode(t, path);
  if (!node || node.type !== 'array') return t;
  const idx = node.children.findIndex(c => same(toData(t, c.value), item));
  return idx === -1 ? t : removeChild(t, node, idx);
}

// Parse JSON(C) text into data (throws on invalid input).
export function parseText(text) {
  const t = normalize(text);
  return toData(t, parseRoot(t));
}
