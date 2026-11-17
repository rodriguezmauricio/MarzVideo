//! Constant-frame-rate slotting: assigns captured frames to output slots and repeats frames over gaps.

use std::io;

/// Maps recording time to output frame slots at a fixed frame rate.
pub struct Slotter {
    frame_hns: f64,
    first: Option<i64>,
    last: Option<u64>,
}

impl Slotter {
    pub fn new(fps: u32) -> Self {
        Self { frame_hns: 10_000_000.0 / fps as f64, first: None, last: None }
    }

    /// Slot for a frame at `rec_hns`; the first frame is slot 0. None when the slot is not after the
    /// last committed one, so the caller can skip the GPU copy. Only remembers the first timestamp:
    /// the slot stays free until `commit`, so a dropped frame does not consume it.
    pub fn slot_for(&mut self, rec_hns: i64) -> Option<u64> {
        let first = *self.first.get_or_insert(rec_hns);
        let idx = (((rec_hns - first) as f64) / self.frame_hns).round().max(0.0) as u64;
        if self.last.is_some_and(|l| idx <= l) {
            return None;
        }
        Some(idx)
    }

    /// Recording time (hns) of slot 0: the first timestamp given to `slot_for`, sent or not.
    pub fn first_rec_hns(&self) -> Option<i64> {
        self.first
    }

    /// Record `idx` as the last slot sent. Call only after the frame was handed to the writer.
    pub fn commit(&mut self, idx: u64) {
        self.last = Some(self.last.map_or(idx, |l| l.max(idx)));
    }

    /// Index of the last slot for a recording of `duration_us` (frame count is the rounded duration
    /// in frames, as in the spike).
    pub fn end_index(&self, duration_us: i64) -> u64 {
        let frames = ((duration_us.max(0) as f64 * 10.0) / self.frame_hns).round() as u64;
        frames.saturating_sub(1)
    }
}

pub trait FrameSink {
    fn write(&mut self, frame: &[u8]) -> io::Result<()>;
}

/// Writes frames to a sink at a constant rate: gaps repeat the previous frame.
pub struct CfrWriter<S: FrameSink> {
    sink: S,
    last: Option<Vec<u8>>,
    next: u64,
}

impl<S: FrameSink> CfrWriter<S> {
    pub fn new(sink: S) -> Self {
        Self { sink, last: None, next: 0 }
    }

    /// Write `frame` at slot `idx`, first repeating the previous frame for every missed slot.
    /// Returns the number of repeats written. `idx` must be after the last written slot.
    pub fn push(&mut self, idx: u64, frame: Vec<u8>) -> io::Result<u64> {
        self.push_recycle(idx, frame).map(|(repeats, _)| repeats)
    }

    /// Like `push`, and also hands back the buffer of the frame it replaced, so a capture loop can
    /// reuse it instead of allocating a new one per frame.
    pub fn push_recycle(&mut self, idx: u64, frame: Vec<u8>) -> io::Result<(u64, Option<Vec<u8>>)> {
        if idx < self.next {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("slot {idx} is not after the last written slot {}", self.next - 1),
            ));
        }
        let mut repeats = 0;
        if let Some(prev) = &self.last {
            while self.next < idx {
                self.sink.write(prev)?;
                self.next += 1;
                repeats += 1;
            }
        }
        self.sink.write(&frame)?;
        self.next = idx + 1;
        Ok((repeats, self.last.replace(frame)))
    }

    /// Pad with the last frame up to and including slot `end_idx`. Returns the repeats written.
    pub fn finish(&mut self, end_idx: u64) -> io::Result<u64> {
        let mut repeats = 0;
        if let Some(prev) = &self.last {
            while self.next <= end_idx {
                self.sink.write(prev)?;
                self.next += 1;
                repeats += 1;
            }
        }
        Ok(repeats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Collect(Vec<Vec<u8>>);
    impl FrameSink for Collect {
        fn write(&mut self, frame: &[u8]) -> io::Result<()> {
            self.0.push(frame.to_vec());
            Ok(())
        }
    }

    #[test]
    fn slot_skips_second_frame_in_same_slot() {
        let mut s = Slotter::new(60);
        let mut last: Option<u64> = None;
        let mut accepted = 0;
        for n in 0..90i64 {
            let t = n * 10_000_000 / 90; // 90 frames per second
            if let Some(i) = s.slot_for(t) {
                assert!(last.is_none_or(|l| i > l), "index {i} not after {last:?}");
                s.commit(i);
                last = Some(i);
                accepted += 1;
            }
        }
        assert_eq!(s.slot_for(0), None); // going backwards is never accepted
        assert!((55..=60).contains(&accepted), "accepted {accepted}");
    }

    #[test]
    fn first_frame_is_slot_zero_and_offsets_are_relative() {
        let mut s = Slotter::new(60);
        assert_eq!(s.slot_for(5_000_000), Some(0));
        s.commit(0);
        assert_eq!(s.slot_for(5_000_000 + 10_000_000 / 60 * 3), Some(3));
    }

    #[test]
    fn first_rec_hns_is_slot_zero_even_if_not_committed() {
        let mut s = Slotter::new(60);
        assert_eq!(s.first_rec_hns(), None);
        assert_eq!(s.slot_for(1_234_567), Some(0)); // slot 0 dropped: no commit
        let later = 1_234_567 + 10_000_000 / 60 + 4_000; // lands in slot 1, 0.4 ms late
        assert_eq!(s.slot_for(later), Some(1));
        s.commit(1);
        assert_eq!(s.first_rec_hns(), Some(1_234_567));
    }

    #[test]
    fn dropped_frame_retried_in_same_slot() {
        let mut s = Slotter::new(60);
        let k = s.slot_for(0).unwrap();
        // no commit: the send failed, so the next frame in the same slot is still accepted
        assert_eq!(s.slot_for(10_000), Some(k));
        s.commit(k);
        assert_eq!(s.slot_for(10_000), None);
    }

    #[test]
    fn end_index_is_last_slot_of_the_duration() {
        let s = Slotter::new(60);
        assert_eq!(s.end_index(1_000_000), 59); // 60 frames, indices 0..=59
        assert_eq!(s.end_index(0), 0);
    }

    #[test]
    fn cfr_writer_repeats_missing_slots() {
        let mut w = CfrWriter::new(Collect::default());
        assert_eq!(w.push(0, vec![1]).unwrap(), 0);
        assert_eq!(w.push(3, vec![2]).unwrap(), 2);
        assert_eq!(w.sink.0, vec![vec![1], vec![1], vec![1], vec![2]]);
    }

    #[test]
    fn push_recycle_returns_the_replaced_buffer() {
        let mut w = CfrWriter::new(Collect::default());
        assert_eq!(w.push_recycle(0, vec![1]).unwrap(), (0, None));
        assert_eq!(w.push_recycle(2, vec![2]).unwrap(), (1, Some(vec![1])));
        assert_eq!(w.sink.0, vec![vec![1], vec![1], vec![2]]);
    }

    #[test]
    fn finish_pads_to_end() {
        let mut w = CfrWriter::new(Collect::default());
        w.push(0, vec![1]).unwrap();
        w.push(3, vec![2]).unwrap();
        assert_eq!(w.finish(10).unwrap(), 7);
        assert_eq!(w.sink.0.len(), 11);
        assert!(w.sink.0[4..].iter().all(|f| f == &vec![2]));
    }

    #[test]
    fn finish_without_frames_writes_nothing() {
        let mut w = CfrWriter::new(Collect::default());
        assert_eq!(w.finish(10).unwrap(), 0);
        assert!(w.sink.0.is_empty());
    }

    #[test]
    fn push_not_after_last_is_invalid_input() {
        let mut w = CfrWriter::new(Collect::default());
        w.push(2, vec![1]).unwrap();
        let err = w.push(2, vec![2]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        let err = w.push(1, vec![2]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }
}
