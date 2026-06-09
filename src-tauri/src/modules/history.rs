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

/// zsh "metafies" its history file: NUL and bytes in `0x83..=0xA2` are written
/// as `Meta` (0x83) followed by the byte XOR 0x20. A single CJK/emoji command
/// therefore makes the raw file invalid UTF-8 — reverse it before decoding, or
/// the whole history read fails and autocomplete silently goes empty.
fn unmetafy(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x83 && i + 1 < bytes.len() {
            out.push(bytes[i + 1] ^ 0x20);
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Decode raw history-file bytes to text without ever failing the whole read:
/// zsh bytes are unmetafied first, and any residual invalid UTF-8 is replaced
/// (per-entry damage at worst), never fatal. Shared with the remote (SSH)
/// reader, whose `cat` of a remote zsh file carries the same metafication.
pub(crate) fn decode_history_bytes(shell: &str, bytes: &[u8]) -> String {
    if shell == "zsh" {
        String::from_utf8_lossy(&unmetafy(bytes)).into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn read_history_text(shell: &str, path: &Path) -> String {
    decode_history_bytes(shell, &std::fs::read(path).unwrap_or_default())
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
        "zsh" => {
            // zsh stores a multiline command as physical lines joined by a
            // trailing backslash; rejoin them or every fragment ("do echo $i",
            // "done", …) shows up as its own bogus entry.
            let mut out: Vec<String> = Vec::new();
            let mut acc: Option<String> = None;
            for line in raw.lines() {
                let (text, continues) = match line.strip_suffix('\\') {
                    Some(t) => (t, true),
                    None => (line, false),
                };
                match acc.as_mut() {
                    Some(a) => {
                        a.push('\n');
                        a.push_str(text);
                    }
                    None => acc = Some(strip_zsh_prefix(text).to_string()),
                }
                if !continues {
                    if let Some(done) = acc.take() {
                        out.push(done.trim_end().to_string());
                    }
                }
            }
            // A dangling continuation at EOF (interrupted write) still counts.
            if let Some(rest) = acc {
                out.push(rest.trim_end().to_string());
            }
            out
        }
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
    let raw = read_history_text(&shell, &path);
    Ok(build_shell_history(
        shell,
        Some(path.to_string_lossy().into_owned()),
        &raw,
        limit,
    ))
}

/// Drop every history record whose command equals `command`. Operates on raw
/// BYTES so kept lines round-trip byte-exact: zsh files are metafied, and
/// re-encoding them through a lossy decode would corrupt the other entries.
/// fish drops the `- cmd:` line plus its indented continuation lines; zsh
/// drops the whole backslash-continuation group of a multiline command.
fn filter_out_entry(shell: &str, raw: &[u8], command: &str) -> Vec<u8> {
    let keep_eol = raw.ends_with(b"\n");
    let mut lines: Vec<&[u8]> = raw.split(|&b| b == b'\n').collect();
    // split() yields a trailing empty slice when the file ends with \n; drop it
    // so the rejoin doesn't grow an extra blank line.
    if keep_eol {
        lines.pop();
    }

    let mut kept: Vec<&[u8]> = Vec::new();
    if shell == "fish" {
        let mut i = 0;
        while i < lines.len() {
            if let Some(cmd) = lines[i].strip_prefix(b"- cmd: ") {
                if unescape_fish(&String::from_utf8_lossy(cmd)) == command {
                    i += 1;
                    while i < lines.len()
                        && (lines[i].starts_with(b" ") || lines[i].starts_with(b"\t"))
                    {
                        i += 1;
                    }
                    continue;
                }
            }
            kept.push(lines[i]);
            i += 1;
        }
    } else if shell == "zsh" {
        let mut i = 0;
        while i < lines.len() {
            // A trailing backslash continues the entry on the next line. Safe
            // to test on raw bytes: a metafied pair's second byte is never \.
            let mut end = i;
            while end + 1 < lines.len() && lines[end].ends_with(b"\\") {
                end += 1;
            }
            let group = &lines[i..=end];
            let mut text = String::new();
            for (k, line) in group.iter().enumerate() {
                let plain = unmetafy(line);
                let cow = String::from_utf8_lossy(&plain);
                let part: &str = cow.strip_suffix('\\').unwrap_or(&cow);
                if k == 0 {
                    text.push_str(strip_zsh_prefix(part));
                } else {
                    text.push('\n');
                    text.push_str(part);
                }
            }
            if text.trim_end() != command {
                kept.extend_from_slice(group);
            }
            i = end + 1;
        }
    } else {
        for line in &lines {
            if String::from_utf8_lossy(line).trim_end() == command {
                continue;
            }
            kept.push(line);
        }
    }

    let mut out = kept.join(&b'\n');
    if keep_eol && !out.is_empty() {
        out.push(b'\n');
    }
    out
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
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    let filtered = filter_out_entry(&shell, &raw, &command);
    write_atomic(&path, &filtered).map_err(|e| {
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
        let raw = b": 1:0;git status\n: 2:0;ls\n: 3:0;git status\n";
        // Both occurrences of the matched command are dropped.
        assert_eq!(filter_out_entry("zsh", raw, "git status"), b": 2:0;ls\n");
    }

    #[test]
    fn delete_removes_fish_entry_with_continuation() {
        let raw = b"- cmd: secret\n  when: 1\n  paths:\n    - /tmp\n- cmd: ls\n  when: 2\n";
        assert_eq!(
            filter_out_entry("fish", raw, "secret"),
            b"- cmd: ls\n  when: 2\n"
        );
    }

    #[test]
    fn zsh_joins_backslash_continued_multiline_commands() {
        let raw = ": 1:0;for i in 1 2\\\ndo echo $i\\\ndone\n: 2:0;ls\n";
        assert_eq!(
            parse_history("zsh", raw),
            vec!["for i in 1 2\ndo echo $i\ndone", "ls"]
        );
    }

    #[test]
    fn zsh_metafied_bytes_decode_instead_of_failing_the_read() {
        // "echo 🚀": f0 9f 9a 80 — zsh metafies 0x9f and 0x9a (Meta 0x83 + ^0x20),
        // which makes the raw file invalid UTF-8.
        let mut raw: Vec<u8> = b": 1:0;echo ".to_vec();
        raw.extend([0xf0, 0x83, 0xbf, 0x83, 0xba, 0x80]);
        raw.extend(b"\n: 2:0;ls\n");
        assert!(String::from_utf8(raw.clone()).is_err());
        let text = decode_history_bytes("zsh", &raw);
        assert_eq!(parse_history("zsh", &text), vec!["echo \u{1f680}", "ls"]);
    }

    #[test]
    fn delete_removes_zsh_multiline_group() {
        let raw = b": 1:0;for i in 1 2\\\ndo echo $i\\\ndone\n: 2:0;ls\n";
        assert_eq!(
            filter_out_entry("zsh", raw, "for i in 1 2\ndo echo $i\ndone"),
            b": 2:0;ls\n"
        );
    }

    #[test]
    fn delete_keeps_metafied_lines_byte_exact() {
        // The kept (metafied, invalid-UTF-8) entry must round-trip untouched.
        let mut raw: Vec<u8> = b": 1:0;echo ".to_vec();
        raw.extend([0xf0, 0x83, 0xbf, 0x83, 0xba, 0x80]);
        raw.extend(b"\n: 2:0;ls\n");
        let mut expected: Vec<u8> = b": 1:0;echo ".to_vec();
        expected.extend([0xf0, 0x83, 0xbf, 0x83, 0xba, 0x80]);
        expected.extend(b"\n");
        assert_eq!(filter_out_entry("zsh", &raw, "ls"), expected);
        // And the metafied entry itself is addressable by its decoded text.
        assert_eq!(
            filter_out_entry("zsh", &raw, "echo \u{1f680}"),
            b": 2:0;ls\n"
        );
    }
}
