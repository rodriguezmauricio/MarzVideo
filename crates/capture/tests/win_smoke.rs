//! Windows smoke test: needs a screen and a microphone, so it is ignored by default.
//! Run with `cargo test -p marz-capture --test win_smoke -- --ignored --nocapture`.
#![cfg(windows)]

use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use marz_capture::clock::RecClock;
use marz_capture::events::{EventLog, EventsHeader};
use marz_capture::slots::{FrameSink, Slotter};
use marz_capture::win::input::{self, InputShared};
use marz_capture::win::mic::{self, MicShared};
use marz_capture::win::monitors::list_monitors;
use marz_capture::win::qpc::{new_guid, qpc_hns};
use marz_capture::win::screen::{self, ScreenShared};
use marz_capture::writer::{self, run_writer, WriterStats};
use marz_capture::win::new_clock;

struct CountSink {
    frames: u64,
    frame_bytes: usize,
}

impl FrameSink for CountSink {
    fn write(&mut self, frame: &[u8]) -> io::Result<()> {
        assert_eq!(frame.len(), self.frame_bytes, "frame size");
        self.frames += 1;
        Ok(())
    }
}

#[test]
#[ignore]
fn smoke_two_seconds() {
    let dir = std::env::temp_dir().join(format!("marz-win-smoke-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let fps = 60;

    let monitors = list_monitors();
    println!("monitors: {monitors:?}");
    let primary = monitors.iter().find(|m| m.primary).expect("a primary monitor");
    let rect = screen::capture_rect(primary.index, None).unwrap();
    let (w, h) = rect.size();
    println!("capture: {rect:?}");
    println!("mics: {:?}", mic::list_mics());
    let guid = new_guid();
    assert_eq!(guid.len(), 36, "{guid}");
    assert_eq!(guid, guid.to_lowercase());

    let clock = new_clock();
    let (warn_tx, warn_rx) = mpsc::channel::<String>();
    let (hk_tx, _hk_rx) = mpsc::channel();

    let input_sh = InputShared::new(clock.clone(), hk_tx, warn_tx.clone());
    let input = input::start(input_sh.clone(), false).unwrap();
    let mic_sh = MicShared::new(clock.clone(), warn_tx.clone());
    let mic = mic::start(None, &dir.join("mic.wav"), mic_sh.clone()).unwrap();
    let screen_sh = ScreenShared::new(clock.clone(), warn_tx.clone());
    let (cap_ends, writer_ends) = writer::frame_pipe();
    let end_idx = writer::new_end_idx();
    let wstats = Arc::new(WriterStats::default());
    let writer = {
        let (e, s) = (end_idx.clone(), wstats.clone());
        let sink = CountSink { frames: 0, frame_bytes: w as usize * h as usize * 4 };
        thread::spawn(move || run_writer(writer_ends, sink, e, s))
    };
    let screen = screen::start(rect, fps, cap_ends, screen_sh.clone()).unwrap();

    // Clock set at once (no warm-up wait), then the events header.
    *clock.lock().unwrap() = Some(RecClock::new(qpc_hns()));
    let header = EventsHeader { width: w, height: h, fps, started_at: "2026-11-17T00:00:00Z".into() };
    let log = EventLog::new(BufWriter::new(File::create(dir.join("events.jsonl")).unwrap()), header, rect.origin, fps).unwrap();
    *input_sh.log.lock().unwrap() = Some(log);

    let mut max_level = 0f32;
    for _ in 0..40 {
        thread::sleep(Duration::from_millis(50));
        max_level = max_level.max(mic_sh.level());
    }

    let duration_us = clock.lock().unwrap().as_ref().unwrap().duration_us(qpc_hns());
    let screen_offset = screen_sh.first_rec_us().expect("a screen frame was sent");
    let end = Slotter::new(fps).end_index(duration_us - screen_offset);
    end_idx.store(end, Ordering::SeqCst);
    screen.stop().unwrap();
    let (sink, res) = writer.join().unwrap();
    res.unwrap();
    let report = mic.stop(duration_us).unwrap();
    input.stop().unwrap();

    let st = &screen_sh.stats;
    println!(
        "duration {duration_us} us; screen offset {screen_offset} us; wgc seen {} sent {} merged {} dropped {} copy failed {}",
        st.frames_seen.load(Ordering::Relaxed),
        st.frames_sent.load(Ordering::Relaxed),
        st.merged.load(Ordering::Relaxed),
        st.dropped_full.load(Ordering::Relaxed),
        st.copy_failed.load(Ordering::Relaxed),
    );
    println!(
        "writer: {} frames ({} repeats), end index {end}",
        wstats.written.load(Ordering::Relaxed),
        wstats.repeated.load(Ordering::Relaxed)
    );
    println!("mic: {report:?}, max level {max_level:.3}");
    let wav_len = fs::metadata(dir.join("mic.wav")).unwrap().len();
    let events = fs::read_to_string(dir.join("events.jsonl")).unwrap();
    println!("mic.wav {wav_len} bytes; events.jsonl {} lines", events.lines().count());
    let warnings: Vec<String> = warn_rx.try_iter().collect();
    println!("warnings: {warnings:?}");

    assert!(screen_sh.is_warm() && mic_sh.is_warm());
    assert!(sink.frames > 0, "frames were delivered");
    assert_eq!(sink.frames, end + 1, "CFR output covers the duration");
    assert!(wav_len > 44 && report.frames > 0, "wav has data");
    assert_eq!(wav_len, 44 + report.frames * 2);
    let mic_offset = report.first_rec_us.unwrap_or(0);
    let expected = (duration_us - mic_offset) * 48_000 / 1_000_000;
    assert!(report.frames.abs_diff(expected as u64) <= 1, "wav length {} vs expected {expected}", report.frames);
    assert!(events.lines().count() >= 2, "header and at least one cursor line");
    let _ = fs::remove_dir_all(&dir);
}
