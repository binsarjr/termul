//! Per-pane scrollback snapshots persisted across app restarts for session
//! restore. Keyed by frontend leaf (pane) id — those ids live in the persisted
//! pane trees and outlive PTY sessions, so this is deliberately not part of
//! `pty/` (whose spill files are per-process and wiped every boot).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;
use tempfile::NamedTempFile;

/// Backstop only — the frontend re-serializes with a smaller scrollback before
/// ever shipping a payload this large.
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
/// Total-directory budget; oldest files go first when prune finds it exceeded.
const MAX_DIR_BYTES: u64 = 64 * 1024 * 1024;

fn snapshots_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("session-snapshots"))
        .map_err(|e| e.to_string())
}

fn snapshot_path(dir: &Path, leaf_id: u32) -> PathBuf {
    dir.join(format!("{leaf_id}.ansi"))
}

/// Atomic replace: write to a temp file in the same directory, then rename
/// over the target so a crash mid-write can't corrupt the snapshot.
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
pub async fn session_snapshot_save(
    app: tauri::AppHandle,
    leaf_id: u32,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!("snapshot too large: {} bytes", data.len()));
    }
    let dir = snapshots_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        write_atomic(&snapshot_path(&dir, leaf_id), data.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_snapshot_load(
    app: tauri::AppHandle,
    leaf_id: u32,
) -> Result<Option<String>, String> {
    let dir = snapshots_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        match fs::read_to_string(snapshot_path(&dir, leaf_id)) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete snapshots for panes that no longer exist, then enforce the
/// total-directory budget (oldest mtime first). Runs only when invoked —
/// at boot after restore and on debounced session saves; no polling.
#[tauri::command]
pub async fn session_snapshots_prune(
    app: tauri::AppHandle,
    keep: Vec<u32>,
) -> Result<(), String> {
    let dir = snapshots_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
        };
        let kept: std::collections::HashSet<String> =
            keep.iter().map(|id| format!("{id}.ansi")).collect();
        let mut survivors: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !kept.contains(&name) {
                let _ = fs::remove_file(&path);
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                survivors.push((path, meta.len(), mtime));
            }
        }
        let mut total: u64 = survivors.iter().map(|(_, len, _)| len).sum();
        if total > MAX_DIR_BYTES {
            survivors.sort_by_key(|(_, _, mtime)| *mtime);
            for (path, len, _) in survivors {
                if total <= MAX_DIR_BYTES {
                    break;
                }
                if fs::remove_file(&path).is_ok() {
                    total = total.saturating_sub(len);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
