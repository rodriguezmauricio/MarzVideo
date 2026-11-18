//! Recording clock: maps QPC time (100 ns units, "hns") to recording time, excluding pauses.

/// Recording time is QPC time minus `t0` minus every paused span before that instant.
/// Pauses are kept as `[start, end)` spans; the last one is open while paused.
pub struct RecClock {
    t0: i64,
    /// Closed pauses, in order.
    pauses: Vec<(i64, i64)>,
    /// Start of the pause in progress, if any.
    open: Option<i64>,
}

impl RecClock {
    pub fn new(t0_hns: i64) -> Self {
        Self { t0: t0_hns, pauses: Vec::new(), open: None }
    }

    /// Start a pause. A pause while already paused is ignored.
    pub fn pause(&mut self, now_hns: i64) {
        if self.open.is_none() {
            self.open = Some(now_hns);
        }
    }

    /// End the pause in progress. A resume while running is ignored.
    pub fn resume(&mut self, now_hns: i64) {
        if let Some(start) = self.open.take() {
            self.pauses.push((start, now_hns.max(start)));
        }
    }

    pub fn is_paused(&self) -> bool {
        self.open.is_some()
    }

    /// Paused time inside `[t0, until)`.
    fn paused_before(&self, until: i64) -> i64 {
        let overlap = |start: i64, end: i64| (end.min(until) - start.max(self.t0)).max(0);
        let closed: i64 = self.pauses.iter().map(|&(s, e)| overlap(s, e)).sum();
        closed + self.open.map_or(0, |s| overlap(s, i64::MAX))
    }

    /// Recording time for a QPC timestamp. None before `t0` or inside a pause.
    pub fn rec_hns(&self, qpc_hns: i64) -> Option<i64> {
        if qpc_hns < self.t0 {
            return None;
        }
        let in_pause = self.pauses.iter().any(|&(s, e)| s <= qpc_hns && qpc_hns < e)
            || self.open.is_some_and(|s| s <= qpc_hns);
        if in_pause {
            return None;
        }
        Some(qpc_hns - self.t0 - self.paused_before(qpc_hns))
    }

    /// Recording length in microseconds when stopped at `stop_hns`. Stopping while paused counts up to the pause.
    pub fn duration_us(&self, stop_hns: i64) -> i64 {
        ((stop_hns - self.t0).max(0) - self.paused_before(stop_hns)) / 10
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i64 = 10_000_000; // one second in hns
    const MS: i64 = 10_000;

    #[test]
    fn rec_time_excludes_pauses() {
        let mut c = RecClock::new(0);
        c.pause(10 * S);
        c.resume(15 * S);
        assert_eq!(c.rec_hns(20 * S), Some(15 * S));
        assert_eq!(c.rec_hns(5 * S), Some(5 * S));
    }

    #[test]
    fn inside_pause_is_none() {
        let mut c = RecClock::new(S);
        assert_eq!(c.rec_hns(S - 1), None); // before t0
        c.pause(10 * S);
        assert!(c.is_paused());
        assert_eq!(c.rec_hns(12 * S), None); // open pause
        c.resume(15 * S);
        assert!(!c.is_paused());
        assert_eq!(c.rec_hns(12 * S), None); // closed pause
        assert_eq!(c.rec_hns(15 * S), Some(9 * S)); // resume instant is live: 15 - t0 1 - paused 5
    }

    #[test]
    fn stop_while_paused() {
        let mut c = RecClock::new(0);
        c.pause(10 * S);
        assert_eq!(c.duration_us(30 * S), 10_000_000);
        c.resume(15 * S);
        c.pause(20 * S);
        assert_eq!(c.duration_us(40 * S), 15_000_000);
    }

    #[test]
    fn repeated_pause_resume() {
        let mut c = RecClock::new(0);
        for i in 0..10 {
            c.pause((100 + i * 100) * MS);
            c.resume((101 + i * 100) * MS);
        }
        let stop = 2 * S;
        assert_eq!(c.duration_us(stop), (stop - 10 * MS) / 10);
        assert_eq!(c.rec_hns(stop), Some(stop - 10 * MS));
    }
}
