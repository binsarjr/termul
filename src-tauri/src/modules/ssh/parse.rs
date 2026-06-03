//! Pure helpers for the SSH remote-fs backend. No I/O so they stay
//! unit-testable on any host.

/// True for an `[user@]host` token safe to hand to `ssh`/`sftp` as an argv
/// element. We pass the token straight to OpenSSH (so `~/.ssh/config` aliases,
/// agent, ProxyJump, known_hosts all apply exactly like the user's terminal),
/// which means the real risk is **argument injection**: a token beginning with
/// `-` would be parsed as a flag (e.g. `-oProxyCommand=...`). Reject that, and
/// restrict to the conservative character set real ssh targets actually use —
/// aliases, hostnames, `user@host`, IPv4, and bracketed IPv6 literals.
pub fn is_valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 255 {
        return false;
    }
    // Argument-injection guard: the token must never look like an option flag.
    if host.starts_with('-') {
        return false;
    }
    host.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | ':' | '[' | ']')
    })
}

/// POSIX shell single-quote: wrap in `'…'`, turning every embedded `'` into
/// `'\''`. Safe to splice into a command line parsed by the remote login shell
/// — bash/zsh/sh/fish all treat single quotes literally and accept the `\'`
/// concatenation trick — so remote paths reach `sh -c` with no word-splitting,
/// globbing, or injection regardless of the characters they contain.
pub fn sq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum RemoteKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, PartialEq)]
pub struct RemoteEntry {
    pub name: String,
    pub kind: RemoteKind,
    pub size: u64,
    pub mtime_ms: u64,
}

/// Map the single type char from the remote lister to a kind. GNU `find -printf
/// %Y` yields `d`/`f`/`l`, and for symlinks it can't resolve `N` (nonexistent),
/// `L` (loop), or `?` (error) — all surfaced as a (broken) symlink. The POSIX
/// fallback emits `d`/`l`/`f`. Everything else (`b`/`c`/`p`/`s`) is a File.
fn kind_from_char(c: char) -> RemoteKind {
    match c {
        'd' => RemoteKind::Dir,
        'l' | 'N' | 'L' | '?' => RemoteKind::Symlink,
        _ => RemoteKind::File,
    }
}

/// Remote mtime fields are epoch seconds, optionally fractional (`find %T@`).
/// Take the integer seconds and scale to ms (the local explorer's unit).
fn parse_mtime_ms(field: &str) -> u64 {
    field
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<u64>()
        .unwrap_or(0)
        .saturating_mul(1000)
}

/// Parse the NUL-delimited `type\tsize\tmtime\tname` records emitted by the
/// remote lister into sorted entries (dirs, then symlinks, then files; each
/// case-insensitive — matching the local `fs_read_dir` ordering). NUL framing
/// is what keeps filenames with spaces/newlines intact; the name is taken as
/// everything after the third TAB so a tab inside a filename survives too.
pub fn parse_dir_listing(stdout: &[u8], show_hidden: bool) -> Vec<RemoteEntry> {
    let text = String::from_utf8_lossy(stdout);
    let mut entries: Vec<RemoteEntry> = text
        .split('\0')
        .filter(|rec| !rec.is_empty())
        .filter_map(|rec| {
            let mut it = rec.splitn(4, '\t');
            let ty = it.next()?;
            let size = it.next()?;
            let mtime = it.next()?;
            let name = it.next()?;
            if name.is_empty() || name == "." || name == ".." {
                return None;
            }
            if name.starts_with('.') && !show_hidden {
                return None;
            }
            Some(RemoteEntry {
                name: name.to_string(),
                kind: kind_from_char(ty.chars().next().unwrap_or('f')),
                size: size.trim().parse().unwrap_or(0),
                mtime_ms: parse_mtime_ms(mtime.trim()),
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        let rank = |k: &RemoteKind| match k {
            RemoteKind::Dir => 0,
            RemoteKind::Symlink => 1,
            RemoteKind::File => 2,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// Parse the single `type\tsize\tmtime` line from the remote stat script.
pub fn parse_stat_line(stdout: &str) -> Option<(RemoteKind, u64, u64)> {
    let line = stdout.lines().find(|l| !l.trim().is_empty())?;
    let mut it = line.splitn(3, '\t');
    let ty = it.next()?;
    let size = it.next()?;
    let mtime = it.next()?;
    Some((
        kind_from_char(ty.trim().chars().next().unwrap_or('f')),
        size.trim().parse().unwrap_or(0),
        parse_mtime_ms(mtime.trim()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_targets() {
        assert!(is_valid_host("pi"));
        assert!(is_valid_host("my-server"));
        assert!(is_valid_host("web_1"));
        assert!(is_valid_host("pi@raspberrypi"));
        assert!(is_valid_host("ubuntu@ec2-1-2-3-4.compute.amazonaws.com"));
        assert!(is_valid_host("192.168.1.5"));
        assert!(is_valid_host("2001:db8::1"));
        assert!(is_valid_host("user@[2001:db8::1]"));
    }

    #[test]
    fn rejects_argument_injection() {
        // The whole point: a leading dash is an option flag, not a host.
        assert!(!is_valid_host("-oProxyCommand=touch /tmp/pwn"));
        assert!(!is_valid_host("-F/dev/null"));
        assert!(!is_valid_host("-"));
    }

    #[test]
    fn rejects_shell_and_control_metachars() {
        assert!(!is_valid_host("host;rm -rf /"));
        assert!(!is_valid_host("host with space"));
        assert!(!is_valid_host("host$(whoami)"));
        assert!(!is_valid_host("host`id`"));
        assert!(!is_valid_host("host\nmore"));
        assert!(!is_valid_host("host&"));
        assert!(!is_valid_host("host|pipe"));
        assert!(!is_valid_host("host/slash"));
    }

    #[test]
    fn rejects_empty_and_overlong() {
        assert!(!is_valid_host(""));
        assert!(!is_valid_host(&"a".repeat(256)));
        assert!(is_valid_host(&"a".repeat(255)));
    }

    #[test]
    fn sq_wraps_plain_value() {
        assert_eq!(sq("/home/pi"), "'/home/pi'");
    }

    #[test]
    fn sq_escapes_embedded_single_quotes() {
        // a'b -> 'a'\''b'  (close, escaped quote, reopen)
        assert_eq!(sq("a'b"), "'a'\\''b'");
        // The classic injection attempt stays inside one quoted token.
        assert_eq!(sq("'; rm -rf /; '"), "''\\''; rm -rf /; '\\'''");
    }

    #[test]
    fn sq_passes_spaces_and_metachars_literally() {
        assert_eq!(sq("my file $(id).txt"), "'my file $(id).txt'");
    }

    #[test]
    fn listing_parses_fields_and_sorts_dirs_first() {
        // type \t size \t mtime \t name, NUL-separated. Out of order on input.
        let raw = b"f\t10\t1700000000\tzeta.txt\0d\t4096\t1700000001\tsrc\0f\t3\t1700000002\talpha\0";
        let out = parse_dir_listing(raw, false);
        assert_eq!(out.len(), 3);
        // dir first, then files alphabetical (case-insensitive)
        assert_eq!(out[0].name, "src");
        assert_eq!(out[0].kind, RemoteKind::Dir);
        assert_eq!(out[0].size, 4096);
        assert_eq!(out[0].mtime_ms, 1700000001000);
        assert_eq!(out[1].name, "alpha");
        assert_eq!(out[2].name, "zeta.txt");
    }

    #[test]
    fn listing_keeps_spaces_and_newlines_in_names() {
        let raw = b"f\t1\t1\tmy file.txt\0f\t1\t1\tline1\nline2\0";
        let out = parse_dir_listing(raw, false);
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"my file.txt"));
        assert!(names.contains(&"line1\nline2"));
    }

    #[test]
    fn listing_respects_show_hidden_and_skips_dot_entries() {
        let raw = b"f\t1\t1\t.bashrc\0f\t1\t1\tvisible\0d\t1\t1\t.\0d\t1\t1\t..\0";
        assert_eq!(parse_dir_listing(raw, false).len(), 1); // only `visible`
        // `.` and `..` are always dropped even with show_hidden.
        let shown = parse_dir_listing(raw, true);
        assert_eq!(shown.len(), 2);
        assert!(shown.iter().any(|e| e.name == ".bashrc"));
    }

    #[test]
    fn listing_maps_symlink_and_fractional_mtime() {
        // %Y of a broken symlink is `N`; %T@ can carry a fractional part.
        let raw = b"N\t12\t1700000000.5000000\tdangling\0";
        let out = parse_dir_listing(raw, false);
        assert_eq!(out[0].kind, RemoteKind::Symlink);
        assert_eq!(out[0].mtime_ms, 1700000000000);
    }

    #[test]
    fn stat_line_parses() {
        assert_eq!(
            parse_stat_line("d\t4096\t1700000000\n"),
            Some((RemoteKind::Dir, 4096, 1700000000000))
        );
        assert_eq!(parse_stat_line("   \n"), None);
    }
}
