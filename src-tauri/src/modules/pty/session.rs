use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter};

use super::agent_detect::AgentDetector;
use super::da_filter::DaFilter;
use super::shell_init;
use super::spill::SpillSink;
use crate::modules::workspace::WorkspaceEnv;

const AGENT_EVENT: &str = "termul:agent-signal";

// Flusher coalesces a short window after first-byte arrival so we send chunks,
// not single bytes. Between bursts it blocks on the condvar with no timeout:
// every notify path sets its predicate under the `pending` mutex (see Pending),
// so an idle session costs zero wakeups.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[termul: dropped output due to backpressure]\x1b[0m\r\n";
// While a tab is hibernated (dormant) the flusher parks output in a bounded
// in-process tail ring instead of waking the webview over IPC. Cap and notice
// mirror the frontend DormantRing so wake behaviour is unchanged.
const DORMANT_BYTE_CAP: usize = 256 * 1024;
const DORMANT_OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[termul: dropped output during hibernation]\x1b[0m\r\n";

/// Tail ring for a dormant tab: whole coalesced chunks, oldest dropped first
/// (dropping a partial prefix would slice an escape sequence in half). When
/// anything was dropped, `take` prepends a hard-reset notice — same contract
/// as the frontend DormantRing.
#[derive(Default)]
struct DormantTail {
    chunks: VecDeque<Vec<u8>>,
    total: usize,
    overflowed: bool,
}

impl DormantTail {
    fn push(&mut self, mut chunk: Vec<u8>) {
        if chunk.is_empty() {
            return;
        }
        if chunk.len() >= DORMANT_BYTE_CAP {
            chunk.drain(..chunk.len() - DORMANT_BYTE_CAP);
            self.chunks.clear();
            self.total = 0;
            self.overflowed = true;
        }
        self.total += chunk.len();
        self.chunks.push_back(chunk);
        while self.total > DORMANT_BYTE_CAP && self.chunks.len() > 1 {
            let dropped = self.chunks.pop_front().expect("len > 1");
            self.total -= dropped.len();
            self.overflowed = true;
        }
    }

    fn take(&mut self) -> Vec<u8> {
        let notice = if self.overflowed {
            DORMANT_OVERFLOW_NOTICE.len()
        } else {
            0
        };
        let mut out = Vec::with_capacity(self.total + notice);
        if self.overflowed {
            out.extend_from_slice(DORMANT_OVERFLOW_NOTICE);
        }
        for c in self.chunks.drain(..) {
            out.extend_from_slice(&c);
        }
        self.total = 0;
        self.overflowed = false;
        out
    }
}

/// Everything the flusher's condvar predicate covers, under one mutex: bytes
/// awaiting flush, the shutdown flag, and the dormant state with its tail
/// ring. Keeping them under a single lock is what makes the untimed `cv.wait`
/// safe — every notify path mutates its predicate while holding this mutex.
#[derive(Default)]
pub(super) struct Pending {
    buf: Vec<u8>,
    done: bool,
    dormant: bool,
    ring: DormantTail,
}

impl Pending {
    /// Flip the dormant state. On wake the buffered tail is spliced back in
    /// front of any not-yet-flushed bytes, so it reaches the frontend over the
    /// regular data channel, in order, ahead of newer output. Returns true
    /// when `buf` gained bytes and the caller must notify the flusher.
    fn set_dormant(&mut self, dormant: bool) -> bool {
        if self.dormant == dormant {
            return false;
        }
        self.dormant = dormant;
        if dormant {
            return false;
        }
        let mut merged = self.ring.take();
        if merged.is_empty() {
            return false;
        }
        merged.append(&mut self.buf);
        self.buf = merged;
        true
    }
}

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    _job: Option<super::job::PtyJob>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    // Disk spill for the per-tab "keep full output" mode. Shared with the
    // flusher/waiter threads; on the last drop its RAII cleanup removes the
    // segment files. Drop order is irrelevant here — it touches no PTY handle.
    pub spill: Arc<Mutex<SpillSink>>,
    // Shared with the reader/flusher/waiter threads: not-yet-flushed bytes
    // plus the dormant state. Drop order irrelevant — no PTY handle.
    pending: Arc<(Mutex<Pending>, Condvar)>,
}

impl Session {
    /// While dormant the flusher buffers output in the in-process tail ring
    /// instead of emitting it over the channel; waking splices the buffered
    /// tail back into the stream.
    pub(super) fn set_dormant(&self, dormant: bool) {
        let (lock, cv) = &*self.pending;
        let notify = lock.lock().unwrap().set_dormant(dormant);
        if notify {
            cv.notify_one();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
// Serializes ConPTY create and close: overlapping pseudoconsole lifecycle
// calls corrupt the new console so its shell never pumps output (issue #356).
#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn drop_session(session: Arc<Session>) {
    #[cfg(windows)]
    let _guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();
    drop(session);
}

struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self { killer: Some(killer) }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut k) = self.killer.take() {
            let _ = k.kill();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<(Arc<Session>, PtySize), String> {
    #[cfg(windows)]
    let _spawn_guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd = shell_init::build_command(cwd, workspace)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Kill the child if any of the pipe setup below fails so the spawned shell
    // can't outlive an aborted pty_open.
    let mut guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    guard.disarm();

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match super::job::PtyJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    // Spill files live under the app cache dir (transient, wiped at startup).
    // If it can't be resolved, the sink is a permanent no-op.
    let spill: Arc<Mutex<SpillSink>> =
        Arc::new(Mutex::new(SpillSink::new(id, super::spill_dir(&app))));

    let pending: Arc<(Mutex<Pending>, Condvar)> = Arc::new((
        Mutex::new(Pending {
            buf: Vec::with_capacity(READ_BUF),
            ..Pending::default()
        }),
        Condvar::new(),
    ));

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        master: Mutex::new(pair.master),
        spill: spill.clone(),
        pending: pending.clone(),
    });

    let spawn_at = Instant::now();

    let pending_r = pending.clone();
    let writer_for_da = writer.clone();
    let app_reader = app.clone();
    let reader_thread = thread::Builder::new()
        .name("termul-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut agent_detect = AgentDetector::new();
            let mut dropped_bytes: u64 = 0;
            let mut logged_first = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !logged_first {
                            logged_first = true;
                            log::debug!("pty first byte after {}ms", spawn_at.elapsed().as_millis());
                        }
                        agent_detect.process(&buf[..n], |t| {
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                        });
                        if filtered.is_empty() {
                            continue;
                        }
                        let (lock, cv) = &*pending_r;
                        let mut g = lock.lock().unwrap();
                        if g.buf.len() + filtered.len() > MAX_PENDING {
                            dropped_bytes += g.buf.len() as u64;
                            g.buf.clear();
                            g.buf.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        g.buf.extend_from_slice(&filtered);
                        cv.notify_one();
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            agent_detect.finish(|t| {
                let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
            });
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .expect("spawn pty reader thread");

    let on_data_flush = on_data.clone();
    let pending_f = pending.clone();
    let spill_f = spill.clone();
    thread::Builder::new()
        .name("termul-pty-flusher".into())
        .spawn(move || {
            let (lock, cv) = &*pending_f;
            loop {
                {
                    let mut g = lock.lock().unwrap();
                    while g.buf.is_empty() {
                        if g.done {
                            return;
                        }
                        g = cv.wait(g).unwrap();
                    }
                }
                // Coalesce a short window so a burst flushes as one chunk.
                thread::sleep(FLUSH_COALESCE);
                let chunk = {
                    let mut g = lock.lock().unwrap();
                    let chunk = std::mem::take(&mut g.buf);
                    // Dormant: park the chunk in the tail ring instead of
                    // waking the webview. Routed under the same lock as the
                    // take so a concurrent wake's splice can never reorder
                    // (spilling waits too — spliced bytes re-enter `buf` and
                    // hit the sink exactly once, on the send path below).
                    if g.dormant {
                        g.ring.push(chunk);
                        continue;
                    }
                    chunk
                };
                if chunk.is_empty() {
                    continue;
                }
                // Persist to disk first (buffered, ~memcpy) so a spilled tab can
                // replay full scrollback on wake without holding it in RAM. A
                // no-op unless the tab enabled "keep full output".
                if let Ok(mut s) = spill_f.lock() {
                    s.write(&chunk);
                }
                if let Err(e) = on_data_flush.send(Response::new(chunk)) {
                    log::debug!("pty flusher exiting, channel closed: {e}");
                    break;
                }
            }
        })
        .expect("spawn pty flusher thread");

    let on_data_exit = on_data;
    let pending_e = pending;
    let spill_e = spill;
    thread::Builder::new()
        .name("termul-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            // Wait for the reader to hit EOF before taking a final snapshot of
            // `pending`, so the last line of output never races the Exit event.
            #[cfg(windows)]
            {
                let deadline = Instant::now() + Duration::from_millis(50);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            let (lock, cv) = &*pending_e;
            let tail = {
                let mut g = lock.lock().unwrap();
                let buf = std::mem::take(&mut g.buf);
                // A session that exits while dormant still owes its parked
                // tail; it predates whatever is left in `buf`.
                let mut tail = g.ring.take();
                if tail.is_empty() {
                    tail = buf;
                } else {
                    tail.extend_from_slice(&buf);
                }
                // Set while holding the pending mutex: the flusher re-checks
                // `done` under the same lock before every untimed wait, so
                // this can never slip between its check and the wait (the
                // lost-wakeup that previously required a 50ms poll).
                g.done = true;
                tail
            };
            cv.notify_all();
            if !tail.is_empty() {
                if let Ok(mut s) = spill_e.lock() {
                    s.write(&tail);
                }
                if let Err(e) = on_data_exit.send(Response::new(tail)) {
                    log::debug!("pty final-data send failed (channel closed): {e}");
                }
            }
            if let Err(e) = on_exit.send(code) {
                log::debug!("pty exit send failed (channel closed): {e}");
            }
        })
        .expect("spawn pty waiter thread");

    Ok((session, size))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;

    #[test]
    fn drop_kills_child_process() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 30");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
            spill: Arc::new(Mutex::new(SpillSink::new(0, None))),
            pending: Arc::new((Mutex::new(Pending::default()), Condvar::new())),
        });

        assert!(
            child.try_wait().unwrap().is_none(),
            "child must be alive before drop",
        );

        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                exited = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(exited, "child still running 2s after Session drop");
    }

    #[test]
    fn drop_session_succeeds_after_child_already_exited() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let _ = child.wait();

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
            spill: Arc::new(Mutex::new(SpillSink::new(0, None))),
            pending: Arc::new((Mutex::new(Pending::default()), Condvar::new())),
        });

        drop_session(session);
    }
}

#[cfg(test)]
mod dormant_tests {
    use super::*;

    #[test]
    fn wake_splices_ring_ahead_of_pending_bytes() {
        let mut p = Pending::default();
        assert!(!p.set_dormant(true), "going dormant needs no notify");
        p.ring.push(b"old".to_vec());
        p.buf.extend_from_slice(b"new");
        assert!(p.set_dormant(false), "wake with buffered tail must notify");
        assert_eq!(p.buf, b"oldnew");
        assert!(p.ring.take().is_empty(), "ring drained by the splice");
    }

    #[test]
    fn wake_without_buffered_output_needs_no_notify() {
        let mut p = Pending::default();
        assert!(!p.set_dormant(true));
        assert!(!p.set_dormant(false));
        assert!(!p.set_dormant(false), "no-op transition");
    }

    #[test]
    fn dormant_tail_drops_oldest_and_prepends_notice() {
        let mut t = DormantTail::default();
        t.push(vec![b'a'; DORMANT_BYTE_CAP]);
        t.push(b"tail".to_vec());
        let out = t.take();
        assert!(out.starts_with(DORMANT_OVERFLOW_NOTICE));
        assert!(out.ends_with(b"tail"));
        assert_eq!(out.len(), DORMANT_OVERFLOW_NOTICE.len() + 4);
    }

    #[test]
    fn dormant_tail_keeps_order_below_cap() {
        let mut t = DormantTail::default();
        t.push(b"one ".to_vec());
        t.push(b"two".to_vec());
        assert_eq!(t.take(), b"one two");
        assert!(t.take().is_empty(), "take drains");
    }

    #[test]
    fn oversized_chunk_keeps_only_its_tail() {
        let mut t = DormantTail::default();
        let mut chunk = vec![b'x'; DORMANT_BYTE_CAP];
        chunk.extend_from_slice(b"end");
        t.push(chunk);
        let out = t.take();
        assert!(out.starts_with(DORMANT_OVERFLOW_NOTICE));
        assert!(out.ends_with(b"end"));
        assert_eq!(out.len(), DORMANT_OVERFLOW_NOTICE.len() + DORMANT_BYTE_CAP);
    }
}
