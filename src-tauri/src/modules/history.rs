//! Read/manage the user's shell history file (zsh/bash/fish/PowerShell).
//!
//! Powers inline autocomplete and the Settings → History manager. Reading is
//! best-effort: a missing file yields an empty list rather than an error, so a
//! fresh machine or an unsupported shell degrades gracefully. Mutations
//! (delete one / clear all) rewrite the file atomically via a temp file in the
//! same directory, so an interrupted write never truncates real history.

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use tempfile::NamedTempFile;

use crate::modules::pty::shell_init;

/// Hard ceiling on returned entries regardless of the requested limit — keeps
/// the IPC payload bounded for users with enormous history files.
const MAX_ENTRIES: usize = 5000;

#[derive(Serialize)]
pub struct ShellHistory {
    /// Short shell name: "zsh" | "bash" | "fish" | "powershell" | "unknown".
    pub shell: String,
    /// Absolute path of the file we read, for display in settings. None when
    /// no history file could be located.
    pub path: Option<String>,
    /// Commands most-recent-first, de-duplicated (newest occurrence wins).
    pub entries: Vec<String>,
}

/// Strip a zsh extended-history prefix (`: <start>:<elapsed>;cmd`) if present.
/// Only strips when the segment between `: ` and the first `;` is `digits:digits`
/// so a plain command that merely contains `;` is left untouched.
fn strip_zsh_prefix(line: &str) -> &str {
    if !line.starts_with(": ") {
        return line;
    }
    let Some(semi) = line.find(';') else {
        return line;
    };
    let meta = &line[2..semi];
    let mut parts = meta.splitn(2, ':');
    let ok = matches!((parts.next(), parts.next()), (Some(a), Some(b))
        if !a.is_empty() && a.bytes().all(|c| c.is_ascii_digit())
            && !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()));
    if ok {
        &line[semi + 1..]
    } else {
        line
    }
}

/// Minimal fish YAML-ish unescape for the `cmd:` value. Fish double-quotes and
/// backslash-escapes values containing special chars; we only need enough to
/// recover the literal command for prefix matching.
fn unescape_fish(value: &str) -> String {
    let v = value.trim();
    let inner = if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        &v[1..v.len() - 1]
    } else {
        v
    };
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse raw history-file text into commands in file order (oldest first).
pub(crate) fn parse_history(shell: &str, raw: &str) -> Vec<String> {
    match shell {
        "fish" => raw
            .lines()
            .filter_map(|l| l.strip_prefix("- cmd: "))
            .map(unescape_fish)
            .collect(),
        "bash" => raw
            .lines()
            // Drop HISTTIMEFORMAT marker lines like `#1700000000`.
            .filter(|l| !(l.starts_with('#') && l[1..].bytes().all(|c| c.is_ascii_digit()) && l.len() > 1))
            .map(|l| l.trim_end().to_string())
            .collect(),
        "zsh" => raw
            .lines()
            .map(|l| strip_zsh_prefix(l).trim_end().to_string())
            .collect(),
        // powershell / unknown: one command per physical line.
        _ => raw.lines().map(|l| l.trim_end().to_string()).collect(),
    }
}

/// Parse `raw` history text for `shell` into a `ShellHistory`: most-recent-first,
/// de-duplicated (newest occurrence wins), capped at `limit` (and `MAX_ENTRIES`).
/// Shared by the local reader and the remote (SSH) reader so both apply the same
/// parsing/dedup/cap rules.
pub(crate) fn build_shell_history(
    shell: String,
    path: Option<String>,
    raw: &str,
    limit: Option<usize>,
) -> ShellHistory {
    let parsed = parse_history(&shell, raw);
    let cap = limit.unwrap_or(MAX_ENTRIES).min(MAX_ENTRIES);
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for cmd in parsed.into_iter().rev() {
        if cmd.is_empty() {
            continue;
        }
        if seen.insert(cmd.clone()) {
            entries.push(cmd);
            if entries.len() >= cap {
                break;
            }
        }
    }
    ShellHistory {
        shell,
        path,
        entries,
    }
}

#[tauri::command]
pub fn read_shell_history(limit: Option<usize>) -> Result<ShellHistory, String> {
    let Some((shell, path)) = shell_init::history_file() else {
        return Ok(ShellHistory {
            shell: "unknown".to_string(),
            path: None,
            entries: Vec::new(),
        });
    };
    // Missing/unreadable file → empty list, not an error (fresh machine, etc).
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(build_shell_history(
        shell,
        Some(path.to_string_lossy().into_owned()),
        &raw,
        limit,
    ))
}

/// Drop every history record whose command equals `command`. Line-based shells
/// (zsh/bash/powershell) drop matching physical lines; fish drops the `- cmd:`
/// line plus its indented continuation lines (when/paths) up to the next entry.
fn filter_out_entry(shell: &str, raw: &str, command: &str) -> String {
    let keep_eol = raw.ends_with('\n');
    let mut out: Vec<String> = Vec::new();

    if shell == "fish" {
        let mut lines = raw.lines().peekable();
        while let Some(line) = lines.next() {
            if let Some(cmd) = line.strip_prefix("- cmd: ") {
                if unescape_fish(cmd) == command {
                    // Skip this entry's indented continuation lines too.
                    while matches!(lines.peek(), Some(next) if next.starts_with(' ') || next.starts_with('\t')) {
                        lines.next();
                    }
                    continue;
                }
            }
            out.push(line.to_string());
        }
    } else {
        for line in raw.lines() {
            let parsed = match shell {
                "zsh" => strip_zsh_prefix(line).trim_end().to_string(),
                "bash" => line.trim_end().to_string(),
                _ => line.trim_end().to_string(),
            };
            if parsed == command {
                continue;
            }
            out.push(line.to_string());
        }
    }

    let mut joined = out.join("\n");
    if keep_eol && !joined.is_empty() {
        joined.push('\n');
    }
    joined
}

/// Atomic replace: write to a temp file in the same directory, then rename over
/// the target so an interrupted write can't corrupt the real history file.
fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

#[tauri::command]
pub fn delete_shell_history_entry(command: String) -> Result<(), String> {
    let Some((shell, path)) = shell_init::history_file() else {
        return Err("no shell history file found".to_string());
    };
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let filtered = filter_out_entry(&shell, &raw, &command);
    write_atomic(&path, filtered.as_bytes()).map_err(|e| {
        log::warn!("delete_shell_history_entry({}) failed: {e}", path.display());
        e.to_string()
    })
}

#[tauri::command]
pub fn clear_shell_history() -> Result<(), String> {
    let Some((_shell, path)) = shell_init::history_file() else {
        return Err("no shell history file found".to_string());
    };
    if !path.exists() {
        return Ok(());
    }
    write_atomic(&path, b"").map_err(|e| {
        log::warn!("clear_shell_history({}) failed: {e}", path.display());
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zsh_extended_history() {
        let raw = ": 1700000000:0;git status\n: 1700000001:2;ls -la\necho plain\n";
        assert_eq!(
            parse_history("zsh", raw),
            vec!["git status", "ls -la", "echo plain"]
        );
    }

    #[test]
    fn zsh_keeps_commands_that_contain_semicolons() {
        let raw = ": 1700000000:0;echo a; echo b\n";
        assert_eq!(parse_history("zsh", raw), vec!["echo a; echo b"]);
    }

    #[test]
    fn bash_drops_timestamp_marker_lines() {
        let raw = "#1700000000\ngit status\n#1700000001\nls\n";
        assert_eq!(parse_history("bash", raw), vec!["git status", "ls"]);
    }

    #[test]
    fn parses_fish_history() {
        let raw = "- cmd: git status\n  when: 1700000000\n- cmd: ls -la\n  when: 1700000001\n";
        assert_eq!(parse_history("fish", raw), vec!["git status", "ls -la"]);
    }

    #[test]
    fn delete_removes_matching_line_only() {
        let raw = ": 1:0;git status\n: 2:0;ls\n: 3:0;git status\n";
        // Both occurrences of the matched command are dropped.
        assert_eq!(filter_out_entry("zsh", raw, "git status"), ": 2:0;ls\n");
    }

    #[test]
    fn delete_removes_fish_entry_with_continuation() {
        let raw = "- cmd: secret\n  when: 1\n  paths:\n    - /tmp\n- cmd: ls\n  when: 2\n";
        assert_eq!(
            filter_out_entry("fish", raw, "secret"),
            "- cmd: ls\n  when: 2\n"
        );
    }
}
