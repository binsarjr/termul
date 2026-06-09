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

/// Emit `TERMULSHELL:<shell>` then the raw history file for the remote login shell,
/// so the same `history.rs` parser handles it. Picks the file from `$SHELL`,
/// falling back to whichever of the known history files is readable. `tail`
/// bounds the payload to the most-recent lines for users with huge histories.
const HISTORY_SCRIPT: &str = r#"s=unknown
f=
case "${SHELL##*/}" in
  zsh) s=zsh; f=$HOME/.zsh_history ;;
  bash) s=bash; f=$HOME/.bash_history ;;
  fish) s=fish; f=$HOME/.local/share/fish/fish_history ;;
esac
if [ -z "$f" ] || [ ! -r "$f" ]; then
  for pair in zsh:.zsh_history bash:.bash_history fish:.local/share/fish/fish_history; do
    t=${pair%%:*}; rel=${pair#*:}
    if [ -r "$HOME/$rel" ]; then s=$t; f=$HOME/$rel; break; fi
  done
fi
printf 'TERMULSHELL:%s\n' "$s"
if [ -n "$f" ] && [ -r "$f" ]; then tail -n 8000 "$f" 2>/dev/null; fi"#;

/// Atomic write of stdin to `$1`: a `mktemp` in the target's own dir (secure
/// random name + O_EXCL, so no pre-staged-symlink attack), stream the content,
/// preserve the target's mode if it existed, then `mv` (same-filesystem rename
/// = atomic). Mirrors the local `write_atomic`.
const WRITE_SCRIPT: &str = r#"target=$1
dir=$(dirname -- "$target")
tmp=$(mktemp "$dir/.termul-XXXXXXXX") || exit 5
mode=$(stat -c '%a' -- "$target" 2>/dev/null || stat -f '%Lp' -- "$target" 2>/dev/null || echo "")
cat > "$tmp" || { rm -f -- "$tmp"; exit 6; }
[ -n "$mode" ] && chmod "$mode" "$tmp"
mv -- "$tmp" "$target" || { rm -f -- "$tmp"; exit 7; }"#;

const CREATE_FILE_SCRIPT: &str = r#"p=$1
if [ -e "$p" ] || [ -L "$p" ]; then printf '%s' "already exists: $p" >&2; exit 1; fi
: > "$p" || exit 2"#;

const CREATE_DIR_SCRIPT: &str = r#"p=$1
if [ -e "$p" ] || [ -L "$p" ]; then printf '%s' "already exists: $p" >&2; exit 1; fi
mkdir -p -- "$p""#;

const RENAME_SCRIPT: &str = r#"from=$1
to=$2
if [ ! -e "$from" ] && [ ! -L "$from" ]; then printf '%s' "not found: $from" >&2; exit 1; fi
if [ -e "$to" ] || [ -L "$to" ]; then printf '%s' "already exists: $to" >&2; exit 1; fi
mv -- "$from" "$to""#;

// `rm -rf` removes a symlink itself (never recurses through it), matching the
// local `symlink_metadata` + remove guarantee. Reject a missing path first so
// the result matches the local "not found" error rather than silently succeeding.
const DELETE_SCRIPT: &str = r#"p=$1
if [ ! -e "$p" ] && [ ! -L "$p" ]; then printf '%s' "not found: $p" >&2; exit 1; fi
rm -rf -- "$p""#;

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

/// Read the remote login shell's history, returning `(shell, raw_file_text)` for
/// `history::build_shell_history` to parse. Best-effort: an unreadable/missing
/// file yields an empty body, never an error.
pub fn read_history(state: &SshState, host: &str) -> Result<(String, String), String> {
    let run = session::exec(state, host, HISTORY_SCRIPT, &[], dur())?;
    if !run.ok() {
        return Err(op_error(host, "history", &run));
    }
    // First line is the `TERMULSHELL:<shell>` marker; everything after it is
    // the raw history file. Split on BYTES before decoding: a remote zsh file
    // is metafied (not valid UTF-8) and must be unmetafied, not lossy-mangled.
    let bytes = &run.stdout;
    let Some(nl) = bytes.iter().position(|&b| b == b'\n') else {
        return Ok(("unknown".to_string(), String::new()));
    };
    let first = String::from_utf8_lossy(&bytes[..nl]);
    let shell = first
        .strip_prefix("TERMULSHELL:")
        .unwrap_or("unknown")
        .trim()
        .to_string();
    let text = crate::modules::history::decode_history_bytes(&shell, &bytes[nl + 1..]);
    Ok((shell, text))
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

pub fn write_file(state: &SshState, host: &str, path: &str, content: &str) -> Result<(), String> {
    let run = session::exec_stdin(
        state,
        host,
        WRITE_SCRIPT,
        &[path],
        content.as_bytes().to_vec(),
        dur(),
    )?;
    if !run.ok() {
        return Err(op_error(host, "write", &run));
    }
    Ok(())
}

pub fn create_file(state: &SshState, host: &str, path: &str) -> Result<(), String> {
    let run = session::exec(state, host, CREATE_FILE_SCRIPT, &[path], dur())?;
    if !run.ok() {
        return Err(op_error(host, "create file", &run));
    }
    Ok(())
}

pub fn create_dir(state: &SshState, host: &str, path: &str) -> Result<(), String> {
    let run = session::exec(state, host, CREATE_DIR_SCRIPT, &[path], dur())?;
    if !run.ok() {
        return Err(op_error(host, "create dir", &run));
    }
    Ok(())
}

pub fn rename(state: &SshState, host: &str, from: &str, to: &str) -> Result<(), String> {
    let run = session::exec(state, host, RENAME_SCRIPT, &[from, to], dur())?;
    if !run.ok() {
        return Err(op_error(host, "rename", &run));
    }
    Ok(())
}

pub fn delete(state: &SshState, host: &str, path: &str) -> Result<(), String> {
    let run = session::exec(state, host, DELETE_SCRIPT, &[path], dur())?;
    if !run.ok() {
        return Err(op_error(host, "delete", &run));
    }
    Ok(())
}
