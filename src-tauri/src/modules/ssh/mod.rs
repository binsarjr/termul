//! Remote file-browser backend over the user's own OpenSSH client.
//! See `session.rs` for the ControlMaster strategy and the auth-reuse rationale.

pub mod ops;
pub mod parse;
pub mod session;
pub mod watch;

pub use session::SshState;
pub use watch::SshWatchState;

use serde::Serialize;
use tauri::Emitter;

use crate::modules::fs::file::{FileStat, ReadResult};
use crate::modules::fs::tree::DirEntry;

#[derive(Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// Run a blocking ssh op off the Tauri async runtime. `tauri::State` can't cross
/// the thread boundary, so callers clone an owned `SshState` (it's `Arc`-backed)
/// before handing the closure in.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Establish (or reuse) the ControlMaster for `host` and return the remote home
/// directory, which the explorer adopts as the browse root.
#[tauri::command]
pub async fn ssh_connect(
    host: String,
    state: tauri::State<'_, SshState>,
) -> Result<String, String> {
    let st = state.inner().clone();
    blocking(move || session::home(&st, &host)).await
}

/// Tear down the ControlMaster for `host` (called when no tab uses it anymore),
/// stopping its poll watcher first.
#[tauri::command]
pub async fn ssh_disconnect(
    host: String,
    state: tauri::State<'_, SshState>,
    watch: tauri::State<'_, SshWatchState>,
) -> Result<(), String> {
    watch::clear_host(watch.inner(), &host);
    let st = state.inner().clone();
    blocking(move || session::disconnect(&st, &host)).await
}

#[tauri::command]
pub async fn ssh_read_dir(
    host: String,
    path: String,
    show_hidden: bool,
    state: tauri::State<'_, SshState>,
) -> Result<Vec<DirEntry>, String> {
    let st = state.inner().clone();
    blocking(move || ops::read_dir(&st, &host, &path, show_hidden)).await
}

#[tauri::command]
pub async fn ssh_read_file(
    host: String,
    path: String,
    state: tauri::State<'_, SshState>,
) -> Result<ReadResult, String> {
    let st = state.inner().clone();
    blocking(move || ops::read_file(&st, &host, &path)).await
}

/// Raw remote bytes for the image/PDF viewers, over Tauri's binary IPC fast
/// path (mirrors `fs_read_bytes`).
#[tauri::command]
pub async fn ssh_read_bytes(
    host: String,
    path: String,
    state: tauri::State<'_, SshState>,
) -> Result<tauri::ipc::Response, String> {
    let st = state.inner().clone();
    let bytes = blocking(move || ops::read_bytes(&st, &host, &path)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn ssh_stat(
    host: String,
    path: String,
    state: tauri::State<'_, SshState>,
) -> Result<FileStat, String> {
    let st = state.inner().clone();
    blocking(move || ops::stat(&st, &host, &path)).await
}

#[tauri::command]
pub async fn ssh_canonicalize(
    host: String,
    path: String,
    state: tauri::State<'_, SshState>,
) -> Result<String, String> {
    let st = state.inner().clone();
    blocking(move || ops::canonicalize(&st, &host, &path)).await
}

#[tauri::command]
pub async fn ssh_write_file(
    host: String,
    path: String,
    content: String,
    source: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    let uri = parse::remote_uri(&host, &path);
    blocking(move || ops::write_file(&st, &host, &path, &content)).await?;
    // Mirror the local fs_write_file event so the markdown preview / sibling
    // editor reload path works for remote files too (keyed by the ssh:// uri).
    let _ = app.emit("fs:file-written", FileWrittenEvent { path: uri, source });
    Ok(())
}

#[tauri::command]
pub async fn ssh_create_file(
    host: String,
    path: String,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || ops::create_file(&st, &host, &path)).await
}

#[tauri::command]
pub async fn ssh_create_dir(
    host: String,
    path: String,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || ops::create_dir(&st, &host, &path)).await
}

#[tauri::command]
pub async fn ssh_rename(
    host: String,
    from: String,
    to: String,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || ops::rename(&st, &host, &from, &to)).await
}

#[tauri::command]
pub async fn ssh_delete(
    host: String,
    path: String,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || ops::delete(&st, &host, &path)).await
}

/// Begin polling `paths` (bare remote dirs) on `host` for changes; emits
/// fs:changed when a watched directory's contents shift.
#[tauri::command]
pub fn ssh_watch_add(
    app: tauri::AppHandle,
    host: String,
    paths: Vec<String>,
    state: tauri::State<SshState>,
    watch: tauri::State<SshWatchState>,
) -> Result<(), String> {
    watch::watch_add(&app, state.inner(), watch.inner(), &host, paths);
    Ok(())
}

#[tauri::command]
pub fn ssh_watch_remove(
    host: String,
    paths: Vec<String>,
    watch: tauri::State<SshWatchState>,
) -> Result<(), String> {
    watch::watch_remove(watch.inner(), &host, paths);
    Ok(())
}
