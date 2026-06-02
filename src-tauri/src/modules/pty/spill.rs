use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};

/// Each segment holds up to this many bytes of raw PTY output before we rotate.
/// We keep at most two segments, so a tab's spill footprint — and the scrollback
/// it can replay on wake — is bounded to between SEG_BYTES and 2*SEG_BYTES.
const SEG_BYTES: u64 = 8 * 1024 * 1024;

/// Per-session disk spill for the per-tab "keep full output" mode. Raw PTY
/// chunks are appended to a two-segment on-disk ring so a hibernated tab can
/// replay its full scrollback on wake without holding it in RAM. Whole coalesced
/// chunks are written verbatim (never split across a segment boundary), so the
/// replayed stream only loses data at the dropped-segment seam — and since a
/// flush chunk is capped well below SEG_BYTES upstream, a chunk never spans two
/// segments.
pub struct SpillSink {
    id: u32,
    /// None when no app cache dir could be resolved — spill is then a no-op.
    dir: Option<PathBuf>,
    enabled: bool,
    writer: Option<BufWriter<File>>,
    cur_len: u64,
    /// True once a full segment has rotated out to segment 0.
    has_prev: bool,
}

impl SpillSink {
    pub fn new(id: u32, dir: Option<PathBuf>) -> Self {
        Self {
            id,
            dir,
            enabled: false,
            writer: None,
            cur_len: 0,
            has_prev: false,
        }
    }

    fn seg_path(dir: &Path, id: u32, n: u8) -> PathBuf {
        dir.join(format!("{id}.{n}"))
    }

    /// Turn spill on or off for this session. Turning it off drops the captured
    /// transcript immediately (the user opted out of keeping it).
    pub fn set_enabled(&mut self, on: bool) {
        if on == self.enabled {
            return;
        }
        self.enabled = on;
        if !on {
            self.reset();
        }
    }

    /// Append one whole flushed chunk. Cheap on the hot path: buffered, with a
    /// file rotation only every SEG_BYTES. A failed write disables spill for the
    /// session rather than spamming the log on every subsequent chunk.
    pub fn write(&mut self, chunk: &[u8]) {
        if !self.enabled || chunk.is_empty() {
            return;
        }
        let Some(dir) = self.dir.clone() else {
            return;
        };
        if let Err(e) = self.write_inner(&dir, chunk) {
            log::warn!("pty spill id={} write failed, disabling: {e}", self.id);
            self.enabled = false;
            self.reset();
        }
    }

    fn write_inner(&mut self, dir: &Path, chunk: &[u8]) -> std::io::Result<()> {
        if self.writer.is_none() {
            fs::create_dir_all(dir)?;
            self.open_current(dir)?;
        }
        // Rotate between chunks so a segment only ever contains whole chunks.
        if self.cur_len > 0 && self.cur_len + chunk.len() as u64 > SEG_BYTES {
            self.rotate(dir)?;
        }
        let w = self.writer.as_mut().expect("writer open after ensure");
        w.write_all(chunk)?;
        self.cur_len += chunk.len() as u64;
        Ok(())
    }

    fn open_current(&mut self, dir: &Path) -> std::io::Result<()> {
        let path = Self::seg_path(dir, self.id, 1);
        let f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)?;
        self.writer = Some(BufWriter::new(f));
        self.cur_len = 0;
        Ok(())
    }

    fn rotate(&mut self, dir: &Path) -> std::io::Result<()> {
        if let Some(mut w) = self.writer.take() {
            w.flush()?;
        }
        let seg0 = Self::seg_path(dir, self.id, 0);
        let seg1 = Self::seg_path(dir, self.id, 1);
        let _ = fs::remove_file(&seg0);
        fs::rename(&seg1, &seg0)?;
        self.has_prev = true;
        self.open_current(dir)
    }

    /// The concatenated tail (older segment then current), flushed to disk first.
    /// Non-destructive — a tab can hibernate and wake repeatedly. Empty when
    /// nothing was captured or on any I/O error.
    pub fn read_tail(&mut self) -> Vec<u8> {
        if let Some(w) = self.writer.as_mut() {
            let _ = w.flush();
        }
        let Some(dir) = self.dir.clone() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if self.has_prev {
            let _ = read_into(&Self::seg_path(&dir, self.id, 0), &mut out);
        }
        let _ = read_into(&Self::seg_path(&dir, self.id, 1), &mut out);
        out
    }

    fn reset(&mut self) {
        self.writer = None;
        self.cur_len = 0;
        self.has_prev = false;
        self.remove_files();
    }

    fn remove_files(&self) {
        if let Some(dir) = &self.dir {
            let _ = fs::remove_file(Self::seg_path(dir, self.id, 0));
            let _ = fs::remove_file(Self::seg_path(dir, self.id, 1));
        }
    }
}

impl Drop for SpillSink {
    fn drop(&mut self) {
        // RAII cleanup: when the session (and its flusher thread) release the
        // last reference, drop the writer and remove both segment files.
        self.writer = None;
        self.remove_files();
    }
}

fn read_into(path: &Path, out: &mut Vec<u8>) -> std::io::Result<()> {
    let mut f = File::open(path)?;
    f.read_to_end(out)?;
    Ok(())
}

/// Wipe the spill directory at startup. Session ids reset each process, so any
/// files left here are debris from a previous (possibly crashed) run.
pub fn cleanup_dir(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sink(tmp: &TempDir) -> SpillSink {
        SpillSink::new(7, Some(tmp.path().to_path_buf()))
    }

    #[test]
    fn disabled_by_default_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        let mut s = sink(&tmp);
        s.write(b"hello");
        assert!(s.read_tail().is_empty());
    }

    #[test]
    fn captures_and_replays_when_enabled() {
        let tmp = TempDir::new().unwrap();
        let mut s = sink(&tmp);
        s.set_enabled(true);
        s.write(b"foo");
        s.write(b"bar");
        assert_eq!(s.read_tail(), b"foobar");
    }

    #[test]
    fn disabling_drops_the_transcript() {
        let tmp = TempDir::new().unwrap();
        let mut s = sink(&tmp);
        s.set_enabled(true);
        s.write(b"keep me");
        assert_eq!(s.read_tail(), b"keep me");
        s.set_enabled(false);
        s.set_enabled(true);
        assert!(s.read_tail().is_empty(), "re-enabling starts fresh");
    }

    #[test]
    fn keeps_only_the_recent_tail_across_rotations() {
        let tmp = TempDir::new().unwrap();
        let mut s = sink(&tmp);
        s.set_enabled(true);
        // Write enough whole chunks to force several rotations. Each chunk is a
        // distinct byte so we can reason about which survive.
        let chunk = vec![b'x'; 1024 * 1024]; // 1 MiB
        let total_chunks = 20; // 20 MiB written; only the last 8–16 MiB kept.
        for _ in 0..total_chunks {
            s.write(&chunk);
        }
        let tail = s.read_tail() as Vec<u8>;
        // Footprint is bounded to [SEG_BYTES, 2*SEG_BYTES).
        assert!(
            (tail.len() as u64) >= SEG_BYTES && (tail.len() as u64) < 2 * SEG_BYTES,
            "tail {} not in [{}, {})",
            tail.len(),
            SEG_BYTES,
            2 * SEG_BYTES
        );
    }

    #[test]
    fn drop_removes_segment_files() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        {
            let mut s = SpillSink::new(7, Some(dir.clone()));
            s.set_enabled(true);
            s.write(b"data");
            assert!(SpillSink::seg_path(&dir, 7, 1).exists());
        }
        assert!(!SpillSink::seg_path(&dir, 7, 1).exists(), "files removed on drop");
        assert!(!SpillSink::seg_path(&dir, 7, 0).exists());
    }

    #[test]
    fn no_dir_is_a_silent_noop() {
        let mut s = SpillSink::new(7, None);
        s.set_enabled(true);
        s.write(b"data");
        assert!(s.read_tail().is_empty());
    }
}
