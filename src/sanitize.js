import { resolve, sep } from 'node:path';

// Names come from repo directory entries — treat as untrusted input.

export function sanitizeName(name) {
  if (typeof name !== 'string') throw new Error('Name must be a string.');
  let s = name.toLowerCase();
  // Replace anything not in safe set with a dash.
  s = s.replace(/[^a-z0-9._-]/g, '-');
  // Strip leading/trailing dots and dashes (blocks hidden files and "..").
  s = s.replace(/^[.\-]+|[.\-]+$/g, '');
  s = s.slice(0, 255);
  if (!s) throw new Error(`Name "${name}" is invalid after sanitization.`);
  return s;
}

// Ensure `target` path is strictly inside `base` to prevent path traversal.
export function assertPathInside(base, target) {
  const resolvedBase = resolve(base) + sep;
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error(
      `Potential path traversal detected: "${resolvedTarget}" is not inside "${resolvedBase}".`
    );
  }
}
