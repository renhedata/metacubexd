// Keep in sync with collector/backends.ts (the daemon's copy — the
// zero-dependency collector bundle cannot import app code).
// Canonical form: scheme + host + path, lowercased host (via WHATWG URL),
// no credentials/query/fragment, no trailing slashes.
export function normalizeBackend(raw: string): string {
  const u = new URL(raw)
  u.username = ''
  u.password = ''
  u.search = ''
  u.hash = ''
  return u.href.replace(/\/+$/, '')
}
