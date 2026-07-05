// Canonical repo-key computation for "is this the same repo?" comparisons.
// Conservative: only normalizes format differences, never merges different hosts.

export function normalizeRepo(input) {
  let s = input.trim();

  // Local absolute paths (Unix /… or Windows C:\…) are not git remote URLs;
  // return them as-is so they compare equal to themselves.
  if (s.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(s)) {
    return s;
  }

  // SCP-style SSH (no :// present and a colon appears before any slash):
  // [user@]host:path  →  host/path
  if (!s.includes('://')) {
    const scpMatch = s.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (scpMatch) {
      const host = scpMatch[1].toLowerCase();
      const path = scpMatch[2].replace(/\.git$/, '').replace(/\/$/, '');
      return `${host}/${path}`;
    }
    // host/path shorthand — strip any accidental user@ prefix.
    s = s.replace(/^[^@/]+@/, '');
  } else {
    // Strip scheme (ssh://, https://, http://, git://).
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    // Strip userinfo (user@ or user:password@).
    s = s.replace(/^[^@]+@/, '');
    // Strip :port from host (digits only, not part of path).
    s = s.replace(/^([^/:]+):\d+(?=\/|$)/, '$1');
  }

  // Lowercase host only; preserve path case.
  const slashIdx = s.indexOf('/');
  if (slashIdx !== -1) {
    const host = s.slice(0, slashIdx).toLowerCase();
    const path = s.slice(slashIdx + 1).replace(/\.git$/, '').replace(/\/$/, '');
    return `${host}/${path}`;
  }
  return s.toLowerCase().replace(/\.git$/, '');
}
