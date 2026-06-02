/** OSC 7 hosts that always denote the local machine regardless of the
 * configured hostname (an empty host — `file:///path` — is local too). */
const ALWAYS_LOCAL = new Set(["", "localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * True when an OSC 7 `file://<host>/path` host refers to this machine, so the
 * path is a real local filesystem path. Lenient about short-name vs FQDN
 * (e.g. "prod" matches "prod.example.com"). When the local hostname is not yet
 * known it returns `true`, so the common non-SSH case is never broken while the
 * hostname loads — at worst remote detection is briefly delayed, never wrong
 * the other way (we don't point the explorer at a remote path).
 */
export function isLocalHost(
  host: string,
  localHostname: string | null,
): boolean {
  const h = host.trim().toLowerCase();
  if (ALWAYS_LOCAL.has(h)) return true;
  if (!localHostname) return true;
  const local = localHostname.trim().toLowerCase();
  if (h === local) return true;
  // short-name vs FQDN, e.g. "prod" <-> "prod.example.com"
  const hShort = h.split(".")[0];
  const localShort = local.split(".")[0];
  return hShort.length > 0 && hShort === localShort;
}
