//! The constant frame rate writer thread and its channels (cross-platform, so it is unit-tested
//! everywhere). The capture side sends `(slot, pixels)` over a depth-6 channel; `run_writer` feeds a
//! `CfrWriter` and sends every replaced buffer back over the pool channel, so steady state
//! allocates nothing.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Arc;

use crate::slots::{CfrWriter, FrameSink};

/// Frames in flight between capture and writer (the spike's queue depth).
pub const QUEUE_FRAMES: usize = 6;

/// How far a WGC timestamp can be ahead of QPC now: the frame's present time, up to one refresh
/// (16.7 ms on a 60 Hz screen, 9.5 ms measured at 165 Hz), plus margin.
pub const HOLD_US: u64 = 20_000;

/// Slots the writer holds back: a frame is written only once a frame this many slots later
/// arrived (or capture stopped). At the moment the stop time is read, frames up to `HOLD_US`
/// past it can already be queued; holding `ceil(HOLD_US / slot) + 1` slots keeps them out of the
/// video. 3 at 60 fps, 6 at 240 fps.
pub fn hold_slots(fps: u32) -> u64 {
    (HOLD_US * u64::from(fps.max(1))).div_ceil(1_000_000) + 1
}

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
/// `fps` sets the hold-back (`hold_slots`).
/// Returns the sink (always, so the session can finish or kill FFmpeg) and the first write error.
pub fn run_writer<S: FrameSink>(ends: WriterEnds, mut sink: S, fps: u32, end_idx: Arc<AtomicU64>, stats: Arc<WriterStats>) -> (S, io::Result<()>) {
    let hold = hold_slots(fps);
    let result = (|| {
        let mut w = CfrWriter::new(ByRef(&mut sink));
        // Write a frame only once a frame `hold` slots later arrived (or capture stopped): frames
        // just past the stop time can arrive before the end is known (see `hold_slots`).
        let mut pending: VecDeque<SlotFrame> = VecDeque::with_capacity(hold as usize + 1);
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
            let newest = frame.0;
            pending.push_back(frame);
            while pending.front().is_some_and(|f| f.0 + hold <= newest) {
                let Some(f) = pending.pop_front() else { break };
                write(&mut w, f)?;
            }
        }
        while let Some(f) = pending.pop_front() {
            write(&mut w, f)?;
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
            thread::spawn(move || run_writer(ends, sink, 60, e, s))
        };
        for idx in 0..=END + hold_slots(60) {
            cap.frames.send((idx, vec![idx as u8])).unwrap();
        }
        // Slot END is written only once END + hold was received, all while the end is unset.
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
    fn hold_follows_the_fps() {
        // ceil(20 ms / slot) + 1
        assert_eq!(hold_slots(60), 3); // slot 16.7 ms: ceil(1.2) + 1
        assert_eq!(hold_slots(240), 6); // slot 4.2 ms: ceil(4.8) + 1
        assert_eq!(hold_slots(50), 2); // exactly one slot: ceil(1.0) + 1
        assert_eq!(hold_slots(30), 2);
    }

    #[test]
    fn two_frames_past_the_end_queued_before_the_end_is_known_are_dropped() {
        // Frames END + 1 and END + 2 (up to 33 ms past the stop at 60 fps) are already queued
        // when the end is stored. With a hold below 3 the writer would have written END + 1.
        const END: u64 = 2;
        let (cap, ends) = frame_pipe();
        let (sink, frames, written) = collect();
        let end_idx = new_end_idx();
        let stats = Arc::new(WriterStats::default());
        for idx in 0..=END + 2 {
            cap.frames.send((idx, vec![idx as u8])).unwrap();
        }
        let writer = {
            let (e, s) = (end_idx.clone(), stats.clone());
            thread::spawn(move || run_writer(ends, sink, 60, e, s))
        };
        while written.recv().unwrap() < END as usize {}
        // Give the writer time to take every queued frame; the hold keeps END and later pending.
        thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(stats.written.load(Ordering::SeqCst), END, "only slots before END written while the end is unset");
        end_idx.store(END, Ordering::SeqCst);
        drop(cap);
        let (_sink, res) = writer.join().unwrap();
        res.unwrap();
        let firsts: Vec<u8> = frames.lock().unwrap().iter().map(|f| f[0]).collect();
        assert_eq!(firsts, vec![0, 1, 2], "frames past the end are dropped");
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
        let (_sink, res) = run_writer(ends, sink, 60, end_idx, stats.clone());
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
        let (_sink, res) = run_writer(ends, sink, 60, new_end_idx(), Arc::new(WriterStats::default()));
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
        let (_sink, res) = run_writer(ends, Broken, 60, new_end_idx(), stats.clone());
        assert_eq!(res.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        assert!(stats.failed.load(Ordering::SeqCst));
    }
}
