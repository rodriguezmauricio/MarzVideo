//! Mic timeline: decides how much silence to pad before each mic packet so the audio
//! stays on the recording clock. Pure logic, no device code.

/// Gaps up to this many frames (5 ms at 48 kHz) are treated as jitter and not padded.
const JITTER_FRAMES: u64 = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAction {
    /// Discard the packet (recording is paused or has not started).
    Drop,
    /// Write `silence_before` frames of silence, then the packet.
    Write { silence_before: u64 },
}

#[derive(Debug)]
pub struct MicTimeline {
    rate: u32,
    first_rec_us: Option<i64>,
    /// (rec_us, frames written) at the last anchor. Expected position runs from here.
    anchor: Option<(i64, u64)>,
    reanchor: bool,
    written: u64,
    padded_frames: u64,
    /// Clock position minus samples written, after padding, at the last packet (frames).
    last_drift_frames: i64,
    /// Largest absolute value of `last_drift_frames` seen.
    max_drift_frames: u64,
}

impl MicTimeline {
    pub fn new(rate: u32) -> Self {
        Self { rate, first_rec_us: None, anchor: None, reanchor: false, written: 0, padded_frames: 0, last_drift_frames: 0, max_drift_frames: 0 }
    }

    /// `rec_hns` is the recording clock in 100 ns units with pauses removed, or `None`
    /// while paused or before the recording starts. `frames` is the packet length.
    pub fn packet(&mut self, rec_hns: Option<i64>, frames: usize) -> MicAction {
        let Some(hns) = rec_hns else {
            if self.first_rec_us.is_some() {
                self.reanchor = true;
            }
            return MicAction::Drop;
        };
        let rec_us = hns / 10;
        let frames = frames as u64;
        let mut silence_before = 0;
        match self.anchor {
            None => {
                self.first_rec_us = Some(rec_us);
                self.anchor = Some((rec_us, self.written));
            }
            Some(_) if self.reanchor => {
                // First packet after a pause: continue from what is written, no padding.
                self.anchor = Some((rec_us, self.written));
            }
            Some((anchor_us, anchor_frames)) => {
                let elapsed_us = (rec_us - anchor_us).max(0) as u128;
                let expected = anchor_frames + (elapsed_us * self.rate as u128 / 1_000_000) as u64;
                if expected > self.written + JITTER_FRAMES {
                    silence_before = expected - self.written;
                    self.padded_frames += silence_before;
                    self.written += silence_before;
                }
                self.last_drift_frames = expected as i64 - self.written as i64;
                self.max_drift_frames = self.max_drift_frames.max(self.last_drift_frames.unsigned_abs());
            }
        }
        self.reanchor = false;
        self.written += frames;
        MicAction::Write { silence_before }
    }

    /// Recording-clock time of the first written packet (becomes `tracks.mic.offsetUs`).
    pub fn first_rec_us(&self) -> Option<i64> {
        self.first_rec_us
    }

    /// Total silence inserted to cover gaps, in microseconds.
    pub fn padded_us(&self) -> i64 {
        (self.padded_frames as u128 * 1_000_000 / self.rate as u128) as i64
    }

    /// Largest gap between the mic clock and the samples written (after padding), in microseconds.
    pub fn max_drift_us(&self) -> i64 {
        self.frames_to_us(self.max_drift_frames as i64)
    }

    /// The same gap at the last packet, signed (positive: the clock is ahead of the samples).
    pub fn last_drift_us(&self) -> i64 {
        self.frames_to_us(self.last_drift_frames)
    }

    fn frames_to_us(&self, frames: i64) -> i64 {
        (i128::from(frames) * 1_000_000 / i128::from(self.rate)) as i64
    }

    fn target_frames(&self, duration_us: i64) -> u64 {
        (duration_us.max(0) as u128 * self.rate as u128 / 1_000_000) as u64
    }

    /// Silence frames to append so the file reaches `duration_us`. Returns 0 if already
    /// there; see `excess_frames` for the over-long case.
    pub fn finish(&mut self, duration_us: i64) -> u64 {
        let target = self.target_frames(duration_us);
        let add = target.saturating_sub(self.written);
        self.written += add;
        add
    }

    /// Frames written beyond `duration_us`, for the caller to truncate.
    pub fn excess_frames(&self, duration_us: i64) -> u64 {
        self.written.saturating_sub(self.target_frames(duration_us))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const PKT: usize = 480; // 10 ms

    fn hns_ms(ms: i64) -> Option<i64> {
        Some(ms * 10_000)
    }

    #[test]
    fn first_packet_sets_offset() {
        let mut t = MicTimeline::new(RATE);
        assert_eq!(t.first_rec_us(), None);
        assert_eq!(t.packet(hns_ms(250), PKT), MicAction::Write { silence_before: 0 });
        assert_eq!(t.first_rec_us(), Some(250_000));
        assert_eq!(t.padded_us(), 0);
    }

    #[test]
    fn contiguous_packets_no_padding() {
        let mut t = MicTimeline::new(RATE);
        for i in 0..100 {
            assert_eq!(t.packet(hns_ms(i * 10), PKT), MicAction::Write { silence_before: 0 });
        }
        assert_eq!(t.padded_us(), 0);
    }

    #[test]
    fn pads_20ms_gap_from_qpc() {
        let mut t = MicTimeline::new(RATE);
        t.packet(hns_ms(0), PKT);
        t.packet(hns_ms(10), PKT);
        // next packet should be at 20 ms but arrives stamped 40 ms
        assert_eq!(t.packet(hns_ms(40), PKT), MicAction::Write { silence_before: 960 });
        assert_eq!(t.padded_us(), 20_000);
        // and the timeline is back on the clock
        assert_eq!(t.packet(hns_ms(50), PKT), MicAction::Write { silence_before: 0 });
    }

    #[test]
    fn drift_is_measured_after_padding() {
        let mut t = MicTimeline::new(RATE);
        t.packet(hns_ms(0), PKT);
        t.packet(hns_ms(13), PKT); // 3 ms late: jitter, not padded
        assert_eq!(t.last_drift_us(), 3_000);
        t.packet(hns_ms(40), PKT); // padded back onto the clock
        assert_eq!(t.last_drift_us(), 0);
        t.packet(hns_ms(48), PKT); // 2 ms early
        assert_eq!(t.last_drift_us(), -2_000);
        assert_eq!(t.max_drift_us(), 3_000);
    }

    #[test]
    fn ignores_small_jitter() {
        let mut t = MicTimeline::new(RATE);
        t.packet(hns_ms(0), PKT);
        t.packet(hns_ms(10), PKT);
        assert_eq!(t.packet(hns_ms(23), PKT), MicAction::Write { silence_before: 0 });
        assert_eq!(t.padded_us(), 0);
    }

    #[test]
    fn drops_samples_while_paused() {
        let mut t = MicTimeline::new(RATE);
        t.packet(hns_ms(0), PKT);
        t.packet(hns_ms(10), PKT);
        assert_eq!(t.packet(None, PKT), MicAction::Drop);
        assert_eq!(t.packet(None, PKT), MicAction::Drop);
        // recording clock excludes the pause, so it resumes at 20 ms, plus a small
        // drift-free continuation: no padding for the paused span
        assert_eq!(t.packet(hns_ms(20), PKT), MicAction::Write { silence_before: 0 });
        assert_eq!(t.packet(hns_ms(30), PKT), MicAction::Write { silence_before: 0 });
        assert_eq!(t.padded_us(), 0);
    }

    #[test]
    fn pause_reanchors_without_drift_penalty() {
        let mut t = MicTimeline::new(RATE);
        t.packet(hns_ms(0), PKT);
        t.packet(hns_ms(10), PKT);
        t.packet(None, PKT);
        // resume lands 100 ms "ahead" of the written position: still no padding
        assert_eq!(t.packet(hns_ms(120), PKT), MicAction::Write { silence_before: 0 });
        // later packets are measured from the new anchor
        assert_eq!(t.packet(hns_ms(130), PKT), MicAction::Write { silence_before: 0 });
        assert_eq!(t.packet(hns_ms(160), PKT), MicAction::Write { silence_before: 960 });
    }

    #[test]
    fn drops_before_start_do_not_set_offset() {
        let mut t = MicTimeline::new(RATE);
        assert_eq!(t.packet(None, PKT), MicAction::Drop);
        assert_eq!(t.first_rec_us(), None);
        assert_eq!(t.packet(hns_ms(5), PKT), MicAction::Write { silence_before: 0 });
        assert_eq!(t.first_rec_us(), Some(5_000));
    }

    #[test]
    fn pads_to_duration_after_device_loss() {
        let mut t = MicTimeline::new(RATE);
        for i in 0..1000 {
            t.packet(hns_ms(i * 10), PKT);
        }
        assert_eq!(t.finish(60_000_000), 50 * 48_000);
        assert_eq!(t.finish(60_000_000), 0);
    }

    #[test]
    fn finish_returns_zero_when_over_and_reports_excess() {
        let mut t = MicTimeline::new(RATE);
        for i in 0..100 {
            t.packet(hns_ms(i * 10), PKT);
        }
        // written 1.0 s, duration 0.9 s
        assert_eq!(t.finish(900_000), 0);
        assert_eq!(t.excess_frames(900_000), 4_800);
        assert_eq!(t.excess_frames(1_000_000), 0);
    }
}
