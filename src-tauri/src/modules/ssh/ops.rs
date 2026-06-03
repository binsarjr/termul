//! Remote filesystem operations over the SSH ControlMaster. Each op runs one
//! small POSIX `sh` script over the master (`session::exec`) and maps the
//! result into the same types the local `fs_*` commands return, so the frontend
//! and viewers can't tell a remote file from a local one.
//!
//! Listing uses `find -printf` (GNU fast path) with a portable `stat` loop
//! fallback, NUL-delimited so filenames with spaces/newlines stay intact. Reads
//! `stat` for size first (to honour the same caps as the local reader) then
//! stream the bytes with `cat`, which is binary-safe.

use std::time::Duration;

use super::parse::{self, RemoteKind};
use super::session::{self, op_error, SshState, EXEC_TIMEOUT_SECS};
use crate::modules::fs::file::{
    classify_bytes, FileStat, ReadResult, StatKind, MAX_READ_BYTES, MAX_READ_BYTES_BINARY,
};
use crate::modules::fs::tree::{DirEntry, EntryKind};

/// Immediate children of `$1`, one NUL-terminated `type\tsize\tmtime\tname`
/// record each. GNU `find -printf` is tried first; on a host without it (BSD /
/// macOS) `find` errors out and the portable `stat` loop takes over. `%Y`
/// reports the followed type without erroring on broken symlinks.
const LIST_SCRIPT: &str = r#"cd -- "$1" 2>/dev/null || exit 3
find . -maxdepth 1 -mindepth 1 -printf '%Y\t%s\t%T@\t%f\0' 2>/dev/null && exit 0
for e in * .*; do
  case "$e" in .|..) continue ;; esac
  [ -e "./$e" ] || [ -L "./$e" ] || continue
  if [ -d "./$e" ]; then t=d; elif [ -L "./$e" ]; then t=l; else t=f; fi
  set -- $(stat -c '%s %Y' -- "./$e" 2>/dev/null || stat -f '%z %m' -- "./$e" 2>/dev/null || echo 0 0)
  printf '%s\t%s\t%s\t%s\0' "$t" "${1:-0}" "${2:-0}" "$e"
done"#;

/// `type\tsize\tmtime` for `$1`. Type follows symlinks (`-d` dereferences);
/// `stat` is tried GNU-style then BSD-style.
const STAT_SCRIPT: &str = r#"p=$1
[ -e "$p" ] || [ -L "$p" ] || exit 4
if [ -d "$p" ]; then t=d; elif [ -L "$p" ]; then t=l; else t=f; fi
set -- $(stat -c '%s %Y' -- "$p" 2>/dev/null || stat -f '%z %m' -- "$p" 2>/dev/null || echo 0 0)
printf '%s\t%s\t%s\n' "$t" "${1:-0}" "${2:-0}""#;

const CANON_SCRIPT: &str =
    r#"realpath -- "$1" 2>/dev/null || readlink -f -- "$1" 2>/dev/null || printf '%s' "$1""#;

const READ_SCRIPT: &str = r#"cat -- "$1""#;

fn entry_kind(k: RemoteKind) -> EntryKind {
    match k {
        RemoteKind::Dir => EntryKind::Dir,
        RemoteKind::Symlink => EntryKind::Symlink,
        RemoteKind::File => EntryKind::File,
    }
}

fn stat_kind(k: RemoteKind) -> StatKind {
    match k {
        RemoteKind::Dir => StatKind::Dir,
        RemoteKind::Symlink => StatKind::Symlink,
        RemoteKind::File => StatKind::File,
    }
}

fn dur() -> Duration {
    Duration::from_secs(EXEC_TIMEOUT_SECS)
}

pub fn read_dir(
    state: &SshState,
    host: &str,
    path: &str,
    show_hidden: bool,
) -> Result<Vec<DirEntry>, String> {
    let run = session::exec(state, host, LIST_SCRIPT, &[path], dur())?;
    if run.exit_code == Some(3) {
        return Err(format!(
            "ssh: cannot open {path} on {host} (no such directory or permission denied)"
        ));
    }
    if !run.ok() {
        return Err(op_error(host, "list", &run));
    }
    Ok(parse::parse_dir_listing(&run.stdout, show_hidden)
        .into_iter()
        .map(|e| DirEntry {
            name: e.name,
            kind: entry_kind(e.kind),
            size: e.size,
            mtime: e.mtime_ms,
        })
        .collect())
}

fn remote_stat(state: &SshState, host: &str, path: &str) -> Result<(RemoteKind, u64, u64), String> {
    let run = session::exec(state, host, STAT_SCRIPT, &[path], dur())?;
    if run.exit_code == Some(4) {
        return Err(format!("ssh: {path} does not exist on {host}"));
    }
    if !run.ok() {
        return Err(op_error(host, "stat", &run));
    }
    parse::parse_stat_line(&run.stdout_string())
        .ok_or_else(|| format!("ssh: cannot stat {path} on {host}"))
}

pub fn stat(state: &SshState, host: &str, path: &str) -> Result<FileStat, String> {
    let (kind, size, mtime) = remote_stat(state, host, path)?;
    Ok(FileStat {
        size,
        mtime,
        kind: stat_kind(kind),
    })
}

fn cat(state: &SshState, host: &str, path: &str) -> Result<Vec<u8>, String> {
    let run = session::exec(state, host, READ_SCRIPT, &[path], dur())?;
    if !run.ok() {
        return Err(op_error(host, "read", &run));
    }
    Ok(run.stdout)
}

pub fn read_file(state: &SshState, host: &str, path: &str) -> Result<ReadResult, String> {
    let (_, size, _) = remote_stat(state, host, path)?;
    if size > MAX_READ_BYTES {
        return Ok(ReadResult::TooLarge {
            size,
            limit: MAX_READ_BYTES,
        });
    }
    let bytes = cat(state, host, path)?;
    Ok(classify_bytes(bytes, size))
}

pub fn read_bytes(state: &SshState, host: &str, path: &str) -> Result<Vec<u8>, String> {
    let (_, size, _) = remote_stat(state, host, path)?;
    if size > MAX_READ_BYTES_BINARY {
        return Err(format!("toolarge:{size}:{MAX_READ_BYTES_BINARY}"));
    }
    cat(state, host, path)
}

pub fn canonicalize(state: &SshState, host: &str, path: &str) -> Result<String, String> {
    let run = session::exec(state, host, CANON_SCRIPT, &[path], dur())?;
    if !run.ok() {
        return Err(op_error(host, "canonicalize", &run));
    }
    let out = run
        .stdout_string()
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    if out.is_empty() {
        Err(format!("ssh: cannot resolve {path} on {host}"))
    } else {
        Ok(out)
    }
}
