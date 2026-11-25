// Line-based YAML-frontmatter helpers. No YAML library: morf only ever needs
// top-level keys with inline values, inline lists or indented blocks.
//
// Every helper is forgiving: text without a frontmatter block is returned
// unchanged (or gets a fresh block when a field has to be added).

// Splits a file into its frontmatter parts. Returns null if no frontmatter block.
export function parseFrontmatter(fileText) {
  // Empty block first ("---\n---"), so the lazy match below cannot run on into
  // a horizontal rule further down the document.
  const e = fileText.match(/^\uFEFF?---[ \t]*\r?\n---[ \t]*(\r?\n|$)/);
  if (e) {
    return { fmLines: [], lineEnding: e[0].includes('\r\n') ? '\r\n' : '\n', trailingSep: e[1], body: fileText.slice(e[0].length) };
  }
  const m = fileText.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return null;
  const fmContent = m[1];
  return {
    fmLines:     fmContent.split(/\r?\n/),
    lineEnding:  m[0].includes('\r\n') ? '\r\n' : '\n',
    trailingSep: m[2],               // '' | '\n' | '\r\n'
    body:        fileText.slice(m[0].length),
  };
}

export function assembleFrontmatter(fmLines, lineEnding, trailingSep, body) {
  if (fmLines.length === 0) return `---${lineEnding}---${trailingSep}${body}`;
  return `---${lineEnding}${fmLines.join(lineEnding)}${lineEnding}---${trailingSep}${body}`;
}

// The document without its frontmatter block.
export function stripFrontmatter(fileText) {
  const parsed = parseFrontmatter(fileText);
  return parsed ? parsed.body.replace(/^(\r?\n)+/, '') : fileText;
}

export function unquote(v) {
  const t = String(v).trim();
  if (t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locate a top-level key. Returns { start, end, inline } (line indexes, inclusive)
// where `inline` is the text after the colon ('' for a block value).
function findField(fmLines, key) {
  const re = new RegExp('^' + escapeRe(key) + '\\s*:(.*)$', 'i');
  for (let i = 0; i < fmLines.length; i++) {
    const m = fmLines[i].match(re);
    if (!m) continue;
    const inline = m[1].trim();
    let end = i;
    if (inline === '' || inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
      for (let j = i + 1; j < fmLines.length; j++) {
        if (/^[ \t]+\S/.test(fmLines[j])) end = j;
        else if (fmLines[j].trim() === '') continue;
        else break;
      }
    }
    return { start: i, end, inline };
  }
  return null;
}

export function hasField(fileText, key) {
  const parsed = parseFrontmatter(fileText);
  return Boolean(parsed && findField(parsed.fmLines, key));
}

// Inline scalar value of a key (unquoted), or null when absent / a block value.
export function getScalar(fileText, key) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return null;
  const f = findField(parsed.fmLines, key);
  if (!f) return null;
  if (f.start !== f.end) {
    // Folded / literal block scalar: join the indented lines.
    if (/^[|>]/.test(f.inline)) {
      return parsed.fmLines.slice(f.start + 1, f.end + 1).map(l => l.trim()).filter(Boolean).join(' ');
    }
    return null;
  }
  return f.inline === '' ? null : unquote(f.inline);
}

// Split on commas that are not inside {...} or [...] (globs use brace sets).
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(x => unquote(x)).filter(Boolean);
}

// A key's value as a list of strings. Accepts `a, b`, `[a, b]`, a quoted
// comma-separated string, or a YAML block list. Missing key -> [].
export function getList(fileText, key) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return [];
  const f = findField(parsed.fmLines, key);
  if (!f) return [];
  if (f.inline !== '' && f.start === f.end) {
    let v = f.inline;
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
    else v = unquote(v);
    return splitTopLevel(v);
  }
  return parsed.fmLines.slice(f.start + 1, f.end + 1)
    .map(l => l.trim())
    .filter(l => l.startsWith('-'))
    .map(l => unquote(l.replace(/^-\s*/, '')))
    .filter(Boolean);
}

// Keys of a block map (`key:\n  a: true\n  b: false`) with their raw values.
export function getMap(fileText, key) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return null;
  const f = findField(parsed.fmLines, key);
  if (!f) return null;
  const out = {};
  if (f.start === f.end) {
    const v = f.inline;
    if (!(v.startsWith('{') && v.endsWith('}'))) return null;
    for (const part of splitTopLevel(v.slice(1, -1))) {
      const m = part.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (m) out[m[1]] = unquote(m[2]);
    }
    return out;
  }
  for (const line of parsed.fmLines.slice(f.start + 1, f.end + 1)) {
    const t = line.trim();
    if (t.startsWith('-')) return null;       // it's a list, not a map
    const m = t.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

// Set (replace or append) a top-level key. `value` is an inline string, or an
// array of already-indented lines for a block value. Creates the frontmatter
// block when the document has none.
export function setField(fileText, key, value) {
  const lines = Array.isArray(value) ? [`${key}:`, ...value] : [`${key}: ${value}`];
  const parsed = parseFrontmatter(fileText);
  if (!parsed) {
    const nl = fileText.includes('\r\n') ? '\r\n' : '\n';
    return `---${nl}${lines.join(nl)}${nl}---${nl}${fileText}`;
  }
  const { fmLines, lineEnding, trailingSep, body } = parsed;
  const f = findField(fmLines, key);
  const next = f
    ? [...fmLines.slice(0, f.start), ...lines, ...fmLines.slice(f.end + 1)]
    : [...fmLines, ...lines];
  return assembleFrontmatter(next, lineEnding, trailingSep || lineEnding, body);
}

export function removeField(fileText, key) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return fileText;
  const { fmLines, lineEnding, trailingSep, body } = parsed;
  const f = findField(fmLines, key);
  if (!f) return fileText;
  return assembleFrontmatter(
    [...fmLines.slice(0, f.start), ...fmLines.slice(f.end + 1)], lineEnding, trailingSep, body);
}

// Comment out one key in place (never delete), appending the reason.
// Returns { text, changed }.
export function commentField(fileText, key, reason) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return { text: fileText, changed: false };
  const { fmLines, lineEnding, trailingSep, body } = parsed;
  const f = findField(fmLines, key);
  if (!f) return { text: fileText, changed: false };
  const result = [...fmLines];
  result[f.start] = `# ${result[f.start]}   (commented by morf: ${reason})`;
  for (let j = f.start + 1; j <= f.end; j++) result[j] = `# ${result[j]}`;
  return { text: assembleFrontmatter(result, lineEnding, trailingSep, body), changed: true };
}

// Comment out every top-level key that is not in `allow` (a Set of lowercase
// names). Returns { text, changed, fields }.
export function commentFieldsExcept(fileText, allow, reason) {
  const parsed = parseFrontmatter(fileText);
  if (!parsed) return { text: fileText, changed: false, fields: [] };

  const { fmLines, lineEnding, trailingSep, body } = parsed;
  const result = [...fmLines];
  const commentedFields = [];

  for (let i = 0; i < result.length; i++) {
    const m = result[i].match(/^([\w-]+)\s*:(.*)/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (allow.has(key)) continue;

    const f = findField(result.slice(i), m[1]);
    const endIdx = i + (f ? f.end : 0);

    result[i] = `# ${result[i]}   (commented by morf: ${reason})`;
    for (let j = i + 1; j <= endIdx; j++) result[j] = `# ${result[j]}`;
    commentedFields.push(key);
    i = endIdx;
  }

  if (commentedFields.length === 0) return { text: fileText, changed: false, fields: [] };
  return {
    text: assembleFrontmatter(result, lineEnding, trailingSep, body),
    changed: true,
    fields: commentedFields,
  };
}

// Quote a string for YAML when it needs it.
export function yamlString(s) {
  const v = String(s);
  if (v === '' || /^[\s>|*&!%@`#'"{}[\],?:-]|[:#]\s|\s$|^(true|false|null|yes|no|~)$/i.test(v) || /: /.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}
