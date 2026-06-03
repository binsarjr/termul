//! OpenSSH ControlMaster session management for the remote file browser.
//!
//! Strategy: never resolve a host ourselves. We invoke the user's own `ssh`
//! client with the bare `[user@]host` token, so `~/.ssh/config` aliases,
//! `IdentityFile`, `User`/`Port`, `ProxyJump`, ssh-agent, and known_hosts all
//! apply byte-for-byte like their terminal `ssh <host>` — zero new auth code.
//!
//! One backgrounded master connection is established per host (`ssh -fNM -S
//! <socket>`); every later file op reuses it over the control socket, so there
//! is a single handshake and no re-auth. Host-key verification is OpenSSH's own
//! (we never pass `StrictHostKeyChecking=no`); a GUI subprocess has no TTY, so
//! `BatchMode=yes` makes a missing key / unknown host fail fast with an error we
//! surface, instead of hanging on a hidden prompt.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use shared_child::SharedChild;

use super::parse::is_valid_host;

/// How long the master may sit idle before OpenSSH tears it down.
const CONTROL_PERSIST_SECS: u64 = 600;
/// TCP connect timeout handed to ssh (`-o ConnectTimeout`).
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Wall-clock backstop for the master-establish process to return.
const ESTABLISH_TIMEOUT_SECS: u64 = 20;
/// Wall-clock cap for a control-op (`-O check`/`-O exit`).
const CONTROL_OP_TIMEOUT_SECS: u64 = 6;
/// Wall-clock cap for a remote command run over the master (pwd, stat, …).
pub const EXEC_TIMEOUT_SECS: u64 = 30;

/// Captured result of an `ssh`/`sftp` subprocess. `stdout` is raw bytes so it
/// is safe for binary file reads and NUL-delimited listings.
pub struct Run {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

impl Run {
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out
    }

    pub fn stdout_string(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }
}

/// Shared, cheaply-cloneable handle so async commands can move an owned copy
/// onto a blocking worker thread (`tauri::State` can't cross thread bounds).
#[derive(Clone, Default)]
pub struct SshState {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    /// One lock per host serializes master creation so concurrent ops don't
    /// race to spawn duplicate masters for the same socket.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl SshState {
    fn host_lock(&self, host: &str) -> Arc<Mutex<()>> {
        let mut map = self.inner.locks.lock().expect("ssh locks poisoned");
        map.entry(host.to_string()).or_default().clone()
    }

    fn forget(&self, host: &str) {
        self.inner
            .locks
            .lock()
            .expect("ssh locks poisoned")
            .remove(host);
    }
}

/// Private, app-owned directory for control sockets: `$XDG_RUNTIME_DIR/ijt-ssh`
/// when available (Linux), else the per-user OS temp dir. Kept short to stay
/// under the ~104-char unix-domain-socket path limit, and `0700` so a local
/// attacker can't hijack the multiplexed session.
fn socket_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("ijt-ssh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("ssh socket dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Deterministic, filesystem-safe socket filename for a host (the host token
/// may contain `@`/`:`/`[]`). `DefaultHasher` has a fixed seed, so the same
/// host always maps to the same socket across ops and runs.
fn host_slug(host: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    host.hash(&mut h);
    format!("{:016x}", h.finish())
}

pub fn socket_path(host: &str) -> Result<PathBuf, String> {
    Ok(socket_dir()?.join(format!("{}.sock", host_slug(host))))
}

/// Run an `ssh`/`sftp` subprocess to completion (or kill it on timeout),
/// mirroring `shell::run_blocking`: piped stdout/stderr drained on their own
/// threads while a waiter thread feeds `recv_timeout`.
pub fn run(program: &str, args: &[String], dur: Duration) -> Result<Run, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| {
        // A missing client binary is the common case worth a clear message.
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("`{program}` not found — OpenSSH client is required for remote files")
        } else {
            e.to_string()
        }
    })?);

    let mut out_pipe = child.take_stdout().ok_or_else(|| {
        let _ = child.kill();
        "no stdout pipe".to_string()
    })?;
    let mut err_pipe = child.take_stderr().ok_or_else(|| {
        let _ = child.kill();
        "no stderr pipe".to_string()
    })?;

    let out_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });

    let (exit_code, timed_out) = match rx.recv_timeout(dur) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("ssh wait thread disconnected".into());
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default())
        .trim()
        .to_string();
    Ok(Run {
        stdout,
        stderr,
        exit_code,
        timed_out,
    })
}

/// `ssh -O check` — true when a live master owns the socket.
fn master_alive(sock: &str, host: &str) -> bool {
    if !Path::new(sock).exists() {
        return false;
    }
    let args = vec![
        "-S".into(),
        sock.into(),
        "-O".into(),
        "check".into(),
        host.into(),
    ];
    matches!(run("ssh", &args, Duration::from_secs(CONTROL_OP_TIMEOUT_SECS)), Ok(r) if r.ok())
}

/// Ensure a live ControlMaster exists for `host`, creating one if needed.
/// Idempotent and safe under concurrency (per-host lock).
pub fn ensure_master(state: &SshState, host: &str) -> Result<(), String> {
    if !is_valid_host(host) {
        return Err(format!("invalid ssh host: {host}"));
    }
    let lock = state.host_lock(host);
    let _guard = lock.lock().expect("ssh host lock poisoned");

    let sock = socket_path(host)?;
    let sock_s = sock.to_string_lossy().into_owned();

    if master_alive(&sock_s, host) {
        return Ok(());
    }
    // A stale socket lingers after a network drop; clear it before recreating.
    if sock.exists() {
        let _ = std::fs::remove_file(&sock);
    }

    let args = vec![
        "-f".into(),
        "-N".into(),
        "-M".into(),
        "-S".into(),
        sock_s.clone(),
        "-o".into(),
        format!("ControlPersist={CONTROL_PERSIST_SECS}"),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        host.into(),
    ];
    let result = run("ssh", &args, Duration::from_secs(ESTABLISH_TIMEOUT_SECS))?;

    if master_alive(&sock_s, host) {
        return Ok(());
    }
    Err(connect_error(host, &result))
}

/// Resolve the remote login directory (browser root) over the master. Run with
/// no command beyond `pwd`, OpenSSH lands in `$HOME`. Take the last non-empty
/// line so a stray login banner on stdout can't corrupt the value.
pub fn home(state: &SshState, host: &str) -> Result<String, String> {
    ensure_master(state, host)?;
    let sock = socket_path(host)?.to_string_lossy().into_owned();
    let args = vec!["-S".into(), sock, host.into(), "pwd".into()];
    let result = run("ssh", &args, Duration::from_secs(EXEC_TIMEOUT_SECS))?;
    if !result.ok() {
        return Err(exec_error(host, "pwd", &result));
    }
    let home = result
        .stdout_string()
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    if home.is_empty() {
        Err(format!("ssh: could not resolve home directory on {host}"))
    } else {
        Ok(home)
    }
}

/// Close the master and remove its socket. Best-effort: a dead session is fine.
pub fn disconnect(state: &SshState, host: &str) -> Result<(), String> {
    if !is_valid_host(host) {
        return Ok(());
    }
    if let Ok(sock) = socket_path(host) {
        let sock_s = sock.to_string_lossy().into_owned();
        if sock.exists() {
            let args = vec![
                "-S".into(),
                sock_s,
                "-O".into(),
                "exit".into(),
                host.into(),
            ];
            let _ = run("ssh", &args, Duration::from_secs(CONTROL_OP_TIMEOUT_SECS));
            let _ = std::fs::remove_file(&sock);
        }
    }
    state.forget(host);
    Ok(())
}

fn connect_error(host: &str, result: &Run) -> String {
    if result.timed_out {
        return format!("ssh: connection to {host} timed out");
    }
    let stderr = result.stderr.trim();
    let lower = stderr.to_lowercase();
    if lower.contains("host key verification failed")
        || lower.contains("no matching host key")
        || lower.contains("remote host identification has changed")
    {
        return format!(
            "ssh: host key for {host} is not accepted. Run `ssh {host}` once in a terminal to verify and accept the host key, then try again."
        );
    }
    if lower.contains("permission denied") {
        return format!(
            "ssh: authentication failed for {host}. Add your key to ssh-agent (a passphrase-protected key can't be unlocked from the GUI)."
        );
    }
    if stderr.is_empty() {
        format!("ssh: could not connect to {host}")
    } else {
        format!("ssh: {stderr}")
    }
}

fn exec_error(host: &str, what: &str, result: &Run) -> String {
    if result.timed_out {
        return format!("ssh: `{what}` on {host} timed out");
    }
    let stderr = result.stderr.trim();
    if stderr.is_empty() {
        format!("ssh: `{what}` on {host} failed (exit {:?})", result.exit_code)
    } else {
        format!("ssh: {stderr}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_slug_is_stable_and_distinct() {
        assert_eq!(host_slug("pi"), host_slug("pi"));
        assert_ne!(host_slug("pi"), host_slug("pi2"));
        assert_ne!(host_slug("pi@a"), host_slug("pi@b"));
        // 16 lowercase hex chars, always.
        let slug = host_slug("user@[2001:db8::1]");
        assert_eq!(slug.len(), 16);
        assert!(slug.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn socket_path_is_short_and_under_the_host() {
        let p = socket_path("raspberrypi.local").expect("socket path");
        let s = p.to_string_lossy();
        // The unix-domain-socket path must stay well under the ~104 byte limit.
        assert!(s.len() < 104, "socket path too long ({}): {s}", s.len());
        assert!(s.ends_with(".sock"));
        assert!(s.contains("ijt-ssh"));
    }

    #[test]
    fn connect_error_hints_at_host_key_acceptance() {
        let run = Run {
            stdout: Vec::new(),
            stderr: "Host key verification failed.".into(),
            exit_code: Some(255),
            timed_out: false,
        };
        let msg = connect_error("pi", &run);
        assert!(msg.contains("ssh pi"), "got: {msg}");
        assert!(msg.contains("host key"), "got: {msg}");
    }

    #[test]
    fn connect_error_reports_timeout() {
        let run = Run {
            stdout: Vec::new(),
            stderr: String::new(),
            exit_code: None,
            timed_out: true,
        };
        assert!(connect_error("pi", &run).contains("timed out"));
    }
}
