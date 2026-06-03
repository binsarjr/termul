//! Live remote-tree refresh by polling. There is no native remote inotify, so
//! for each expanded remote directory we periodically compute a cheap signature
//! (entry names + sizes + mtimes, hashed) over the master and emit `fs:changed`
//! — the same event the local notify watcher uses — when a signature moves. One
//! poll thread per host fingerprints all of that host's watched dirs in a single
//! round-trip.
//!
//! GNU-`find` based; on a BSD/macOS remote the signature stays constant (no
//! false positives) and the tree relies on manual Refresh instead.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::parse;
use super::session::{self, SshState};

const POLL_INTERVAL: Duration = Duration::from_secs(4);
const POLL_TIMEOUT: Duration = Duration::from_secs(15);

/// One `dir\tsize\tmtime` line per entry, hashed to a single `cksum` token per
/// watched dir; emitted as `signature\tdir`, NUL-delimited across dirs.
const SIG_SCRIPT: &str = r#"for d in "$@"; do
  s=$(find "$d" -maxdepth 1 -printf '%f\t%s\t%T@\n' 2>/dev/null | LC_ALL=C sort | cksum 2>/dev/null)
  printf '%s\t%s\0' "$s" "$d"
done"#;

#[derive(Serialize, Clone)]
struct FsChanged {
    paths: Vec<String>,
}

#[derive(Default)]
struct HostWatch {
    dirs: HashSet<String>,
    sigs: HashMap<String, String>,
    running: bool,
}

#[derive(Clone, Default)]
pub struct SshWatchState {
    inner: Arc<Mutex<HashMap<String, HostWatch>>>,
}

/// Start watching `dirs` (bare remote paths) on `host`, spawning the host's poll
/// thread if it isn't already running.
pub fn watch_add(
    app: &AppHandle,
    ssh: &SshState,
    watch: &SshWatchState,
    host: &str,
    dirs: Vec<String>,
) {
    let mut need_start = false;
    {
        let mut map = watch.inner.lock().expect("ssh watch poisoned");
        let hw = map.entry(host.to_string()).or_default();
        for d in dirs {
            hw.dirs.insert(d);
        }
        if !hw.dirs.is_empty() && !hw.running {
            hw.running = true;
            need_start = true;
        }
    }
    if need_start {
        spawn_poll(app.clone(), ssh.clone(), watch.clone(), host.to_string());
    }
}

/// Stop watching `dirs` on `host`. The poll thread self-stops once the host has
/// no watched dirs left.
pub fn watch_remove(watch: &SshWatchState, host: &str, dirs: Vec<String>) {
    let mut map = watch.inner.lock().expect("ssh watch poisoned");
    if let Some(hw) = map.get_mut(host) {
        for d in &dirs {
            hw.dirs.remove(d);
            hw.sigs.remove(d);
        }
    }
}

/// Drop all watches for a host (called on disconnect so its poll thread stops).
pub fn clear_host(watch: &SshWatchState, host: &str) {
    let mut map = watch.inner.lock().expect("ssh watch poisoned");
    if let Some(hw) = map.get_mut(host) {
        hw.dirs.clear();
        hw.sigs.clear();
    }
}

fn spawn_poll(app: AppHandle, ssh: SshState, watch: SshWatchState, host: String) {
    thread::spawn(move || loop {
        thread::sleep(POLL_INTERVAL);

        let dirs: Vec<String> = {
            let mut map = watch.inner.lock().expect("ssh watch poisoned");
            let Some(hw) = map.get_mut(&host) else {
                break;
            };
            if hw.dirs.is_empty() {
                hw.running = false;
                break;
            }
            hw.dirs.iter().cloned().collect()
        };

        let changed = poll_once(&ssh, &watch, &host, &dirs);
        if !changed.is_empty() {
            let paths = changed
                .iter()
                .map(|d| parse::remote_uri(&host, d))
                .collect();
            let _ = app.emit("fs:changed", FsChanged { paths });
        }
    });
}

/// Fingerprint all `dirs` in one round-trip; return the dirs whose signature
/// moved since last poll. The first observation of a dir only records a
/// baseline (no emit), so expanding a directory never triggers a spurious
/// refresh.
fn poll_once(ssh: &SshState, watch: &SshWatchState, host: &str, dirs: &[String]) -> Vec<String> {
    let args: Vec<&str> = dirs.iter().map(String::as_str).collect();
    let run = match session::exec(ssh, host, SIG_SCRIPT, &args, POLL_TIMEOUT) {
        Ok(r) if r.ok() => r,
        // Master down / transient error: skip this round and try again later.
        _ => return Vec::new(),
    };
    let sigs = parse::parse_watch_signatures(&run.stdout);

    let mut changed = Vec::new();
    let mut map = watch.inner.lock().expect("ssh watch poisoned");
    let Some(hw) = map.get_mut(host) else {
        return Vec::new();
    };
    for (dir, sig) in sigs {
        if !hw.dirs.contains(&dir) {
            continue; // unwatched since the snapshot
        }
        match hw.sigs.get(&dir) {
            Some(prev) if *prev == sig => {}
            Some(_) => {
                hw.sigs.insert(dir.clone(), sig);
                changed.push(dir);
            }
            None => {
                hw.sigs.insert(dir, sig); // baseline, no emit
            }
        }
    }
    changed
}
