//! Remote file-browser backend over the user's own OpenSSH client.
//! See `session.rs` for the ControlMaster strategy and the auth-reuse rationale.

pub mod parse;
pub mod session;

pub use session::SshState;

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

/// Tear down the ControlMaster for `host` (called when no tab uses it anymore).
#[tauri::command]
pub async fn ssh_disconnect(
    host: String,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || session::disconnect(&st, &host)).await
}
