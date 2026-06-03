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
}
