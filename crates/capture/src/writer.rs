//! The constant frame rate writer thread and its channels (cross-platform, so it is unit-tested
//! everywhere). The capture side sends `(slot, pixels)` over a depth-6 channel; `run_writer` feeds a
//! `CfrWriter` and sends every replaced buffer back over the pool channel, so steady state
//! allocates nothing.

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Arc;

use crate::slots::{CfrWriter, FrameSink};

/// Frames in flight between capture and writer (the spike's queue depth).
pub const QUEUE_FRAMES: usize = 6;

/// One output frame: slot index and tightly packed BGRA pixels.
pub type SlotFrame = (u64, Vec<u8>);

/// What the capture side (`win::screen::start`) needs: frames out, recycled buffers in.
pub struct CaptureEnds {
    pub(crate) frames: SyncSender<SlotFrame>,
    pub(crate) pool: Receiver<Vec<u8>>,
}

/// What `run_writer` needs: frames in, recycled buffers out.
pub struct WriterEnds {
    frames: Receiver<SlotFrame>,
    pool: Sender<Vec<u8>>,
}

/// The frame channel (depth 6) and the buffer pool channel between capture and writer.
pub fn frame_pipe() -> (CaptureEnds, WriterEnds) {
    let (frames_tx, frames_rx) = mpsc::sync_channel::<SlotFrame>(QUEUE_FRAMES);
    let (pool_tx, pool_rx) = mpsc::channel::<Vec<u8>>();
    (CaptureEnds { frames: frames_tx, pool: pool_rx }, WriterEnds { frames: frames_rx, pool: pool_tx })
}

#[derive(Debug, Default)]
pub struct WriterStats {
    /// Frames written to the sink, repeats included.
    pub written: AtomicU64,
    /// Repeats of the previous frame (gaps and the pad to the end).
    pub repeated: AtomicU64,
    /// Set when a sink write failed (FFmpeg died); the writer stops taking frames.
    pub failed: AtomicBool,
}

/// Lets `CfrWriter` borrow the sink, so `run_writer` can hand it back for `ScreenEncoder::finish`.
struct ByRef<'a, S: FrameSink>(&'a mut S);

impl<S: FrameSink> FrameSink for ByRef<'_, S> {
    fn write(&mut self, frame: &[u8]) -> io::Result<()> {
        self.0.write(frame)
    }
}

/// `end_idx` value meaning "stop time not known yet".
pub const END_UNSET: u64 = u64::MAX;

/// The shared last-slot index for `run_writer`, starting unset.
pub fn new_end_idx() -> Arc<AtomicU64> {
    Arc::new(AtomicU64::new(END_UNSET))
}

/// The writer thread body: writes frames at a constant rate until the capture side is stopped,
/// then pads with the last frame up to and including slot `end_idx`. `end_idx` starts at
/// `END_UNSET` (`new_end_idx`). The session must store the real value right after it reads the
/// stop duration, before it stops the capture (`Slotter::end_index(duration_us - screen offsetUs)`);
/// without it the end is not padded. Frames after it (they arrive while WGC
/// stops) are discarded, so the video is exactly `end_idx + 1` frames.
/// Returns the sink (always, so the session can finish or kill FFmpeg) and the first write error.
pub fn run_writer<S: FrameSink>(ends: WriterEnds, mut sink: S, end_idx: Arc<AtomicU64>, stats: Arc<WriterStats>) -> (S, io::Result<()>) {
    let result = (|| {
        let mut w = CfrWriter::new(ByRef(&mut sink));
        // Write a frame only once the next one arrived (or capture stopped): a frame in the last
        // half-slot before the stop time rounds to `end + 1` and can arrive before the end is known.
        let mut pending: Option<SlotFrame> = None;
        let write = |w: &mut CfrWriter<_>, (idx, px): SlotFrame| -> io::Result<()> {
            if idx > end_idx.load(Ordering::SeqCst) {
                let _ = ends.pool.send(px);
                return Ok(());
            }
            let (repeats, old) = w.push_recycle(idx, px)?;
            stats.written.fetch_add(repeats + 1, Ordering::Relaxed);
            stats.repeated.fetch_add(repeats, Ordering::Relaxed);
            if let Some(old) = old {
                let _ = ends.pool.send(old);
            }
            Ok(())
        };
        for frame in ends.frames.iter() {
            if let Some(prev) = pending.replace(frame) {
                write(&mut w, prev)?;
            }
        }
        if let Some(last) = pending.take() {
            write(&mut w, last)?;
        }
        let end = end_idx.load(Ordering::SeqCst);
        let repeats = if end == END_UNSET { 0 } else { w.finish(end)? };
        stats.written.fetch_add(repeats, Ordering::Relaxed);
        stats.repeated.fetch_add(repeats, Ordering::Relaxed);
        Ok(())
    })();
    if result.is_err() {
        stats.failed.store(true, Ordering::SeqCst);
    }
    // `ends` drops here: the capture side sees Disconnected and stops sending.
    (sink, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::thread;

    /// Records every written frame and reports the running count.
    struct Collect {
        frames: Arc<Mutex<Vec<Vec<u8>>>>,
        written: Sender<usize>,
    }

    impl FrameSink for Collect {
        fn write(&mut self, frame: &[u8]) -> io::Result<()> {
            let mut f = self.frames.lock().unwrap();
            f.push(frame.to_vec());
            let _ = self.written.send(f.len());
            Ok(())
        }
    }

    type Frames = Arc<Mutex<Vec<Vec<u8>>>>;

    fn collect() -> (Collect, Frames, Receiver<usize>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        (Collect { frames: frames.clone(), written: tx }, frames, rx)
    }

    #[test]
    fn frame_past_end_that_arrived_before_end_was_known_is_dropped() {
        const END: u64 = 3;
        let (cap, ends) = frame_pipe();
        let (sink, frames, written) = collect();
        let end_idx = new_end_idx();
        let stats = Arc::new(WriterStats::default());
        let writer = {
            let (e, s) = (end_idx.clone(), stats.clone());
            thread::spawn(move || run_writer(ends, sink, e, s))
        };
        for idx in 0..=END + 1 {
            cap.frames.send((idx, vec![idx as u8])).unwrap();
        }
        // Slot END is written only once END + 1 was received, all while the end is still unset.
        while written.recv().unwrap() < (END + 1) as usize {}
        end_idx.store(END, Ordering::SeqCst);
        drop(cap);
        let (_sink, res) = writer.join().unwrap();
        res.unwrap();
        let frames = frames.lock().unwrap();
        assert_eq!(frames.len() as u64, END + 1, "exactly end + 1 frames");
        assert_eq!(frames.last().unwrap(), &vec![END as u8], "the last real frame is written");
        assert_eq!(stats.written.load(Ordering::SeqCst), END + 1);
        assert_eq!(stats.repeated.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn gaps_and_end_are_padded_and_buffers_come_back() {
        let (cap, ends) = frame_pipe();
        let (sink, frames, _written) = collect();
        let end_idx = new_end_idx();
        let stats = Arc::new(WriterStats::default());
        cap.frames.send((0, vec![0])).unwrap();
        cap.frames.send((3, vec![3])).unwrap();
        cap.frames.send((4, vec![4])).unwrap();
        end_idx.store(6, Ordering::SeqCst);
        let CaptureEnds { frames: tx, pool } = cap;
        drop(tx);
        let (_sink, res) = run_writer(ends, sink, end_idx, stats.clone());
        res.unwrap();
        let frames = frames.lock().unwrap();
        let firsts: Vec<u8> = frames.iter().map(|f| f[0]).collect();
        assert_eq!(firsts, vec![0, 0, 0, 3, 4, 4, 4]);
        assert_eq!(stats.repeated.load(Ordering::SeqCst), 4);
        // the replaced buffers of slots 0 and 3 went back to the pool
        let back: Vec<Vec<u8>> = pool.try_iter().collect();
        assert_eq!(back, vec![vec![0], vec![3]]);
    }

    #[test]
    fn end_unset_writes_every_frame_without_padding() {
        let (cap, ends) = frame_pipe();
        let (sink, frames, _written) = collect();
        cap.frames.send((0, vec![0])).unwrap();
        cap.frames.send((2, vec![2])).unwrap();
        drop(cap);
        let (_sink, res) = run_writer(ends, sink, new_end_idx(), Arc::new(WriterStats::default()));
        res.unwrap();
        assert_eq!(frames.lock().unwrap().len(), 3);
    }

    struct Broken;
    impl FrameSink for Broken {
        fn write(&mut self, _frame: &[u8]) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "ffmpeg exited"))
        }
    }

    #[test]
    fn sink_error_sets_failed_and_returns_the_error() {
        let (cap, ends) = frame_pipe();
        cap.frames.send((0, vec![0])).unwrap();
        drop(cap);
        let stats = Arc::new(WriterStats::default());
        let (_sink, res) = run_writer(ends, Broken, new_end_idx(), stats.clone());
        assert_eq!(res.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        assert!(stats.failed.load(Ordering::SeqCst));
    }
}
