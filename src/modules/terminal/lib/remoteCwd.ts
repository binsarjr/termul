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

/** ssh option flags that consume the FOLLOWING token as their value, e.g.
 * `-p 2222` or `-i ~/.ssh/id`. A flag with its value glued on (`-p2222`,
 * `-i/path`) consumes nothing extra; everything else (`-4`, `-tt`, `-v`,
 * `-Nf`) is boolean/combined and consumes nothing. */
const SSH_VALUE_FLAGS = new Set([
  "b", "c", "D", "E", "e", "F", "I", "i", "J", "L", "l", "m",
  "O", "o", "p", "Q", "R", "S", "W", "w",
]);

/** Reduce a `[user@]host[:port][/path]` token (optionally `ssh://`-prefixed)
 * to the bare host, or null when no host remains. */
function bareHost(token: string): string | null {
  let t = token;
  // Strip an ssh:// (or any leading scheme://) prefix.
  const scheme = t.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (scheme) t = t.slice(scheme[0].length);
  // Strip user@ (the last @ wins, matching ssh's own parsing of user@host).
  const at = t.lastIndexOf("@");
  if (at >= 0) t = t.slice(at + 1);
  // Drop a trailing /path component (only present in the ssh:// URL form).
  const slash = t.indexOf("/");
  if (slash >= 0) t = t.slice(0, slash);
  // Drop a :port suffix. Skip bracketed IPv6 literals ([::1]) — their colons
  // are part of the address; only a colon AFTER the closing bracket is a port.
  if (t.startsWith("[")) {
    const close = t.indexOf("]");
    if (close >= 0) t = t.slice(1, close);
  } else {
    const colon = t.indexOf(":");
    if (colon >= 0) t = t.slice(0, colon);
  }
  return t.length > 0 ? t : null;
}

/**
 * Detect an `ssh <host>` invocation from a captured command line and return the
 * bare host, or null when it isn't an ssh command. Pure and defensive: never
 * throws. Used to surface a "remote" indicator the moment a local `ssh` runs,
 * even against a stock remote shell that emits no OSC 7 / OSC 133 of its own.
 *
 * Rejects sibling tools whose name merely starts with "ssh" (ssh-keygen,
 * ssh-add, ssh-copy-id, ssh-agent, sshfs, sshpass, autossh): the first token's
 * basename must equal "ssh" exactly. Also accepts the `ssh://[user@]host[:port]`
 * URL form when it's the first non-flag token.
 */
export function parseSshHost(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  // The first token may be `ssh`, a path to it (/usr/bin/ssh), or an ssh:// URL
  // standing in for the whole command. Reject anything whose basename isn't ssh.
  const isSchemeForm = /^ssh:\/\//i.test(head);
  if (!isSchemeForm) {
    const base = head.split(/[\\/]/).pop() ?? "";
    if (base !== "ssh") return null;
  }
  // When the first token itself is the ssh:// URL, the host lives there.
  if (isSchemeForm) return bareHost(head);
  // Walk the remaining tokens, skipping option flags (and the value tokens that
  // value-flags pull along), until the first positional [user@]host.
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("-")) {
      if (tok === "-") return null; // bare "-" isn't a host
      // A long-flag style (--foo) carries no separate value token here.
      if (tok.startsWith("--")) continue;
      // Short-flag handling. OpenSSH bundles boolean short flags and lets the
      // LAST flag in the bundle take a value — either glued on or as the next
      // token (`-Cp 2222`, `-qp 2222`, `-fp 2222` all consume "2222"). Scan the
      // bundle for the first value-flag char: if it's the bundle's last char,
      // its value is the following token, so skip it (i++). If it appears
      // mid-bundle, the rest of the bundle IS its glued value and nothing extra
      // is consumed (`-p2222`, `-fp2222`).
      const body = tok.slice(1);
      const k = [...body].findIndex((ch) => SSH_VALUE_FLAGS.has(ch));
      if (k >= 0 && k === body.length - 1) i++;
      continue;
    }
    return bareHost(tok);
  }
  return null;
}
