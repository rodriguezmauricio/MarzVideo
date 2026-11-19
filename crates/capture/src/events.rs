//! Writer for `events.jsonl`: the recorder-owned, append-only input event log.
//!
//! One JSON object per line. Timestamps are microseconds since recording start on the recording
//! clock. Coordinates are pixels in the captured frame, so the capture region origin is subtracted.

use serde::Serialize;
use std::io::{self, Write};

const FLUSH_INTERVAL_US: i64 = 1_000_000;

/// Values for the `header` line.
#[derive(Debug, Clone)]
pub struct EventsHeader {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// RFC 3339 UTC timestamp, e.g. `2026-11-17T10:00:00Z`.
    pub started_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ZoomAction {
    In,
    Out,
}

#[derive(Serialize)]
struct Source {
    width: u32,
    height: u32,
    fps: u32,
}

#[derive(Serialize)]
struct HeaderLine<'a> {
    r#type: &'static str,
    version: u32,
    source: Source,
    #[serde(rename = "startedAt")]
    started_at: &'a str,
}

#[derive(Serialize)]
struct CursorLine {
    #[serde(rename = "tUs")]
    t_us: i64,
    r#type: &'static str,
    x: i32,
    y: i32,
}

#[derive(Serialize)]
struct CursorShapeLine<'a> {
    #[serde(rename = "tUs")]
    t_us: i64,
    r#type: &'static str,
    shape: &'a str,
    px: u32,
}

/// Cursor shape names written in `cursorShape` lines (see the cursor and clicks design doc).
pub const CURSOR_SHAPES: [&str; 15] = [
    "arrow", "hand", "ibeam", "wait", "progress", "cross", "move", "sizeNS", "sizeWE", "sizeNWSE", "sizeNESW", "no", "help",
    "hidden", "other",
];

#[derive(Serialize)]
struct ClickLine {
    #[serde(rename = "tUs")]
    t_us: i64,
    r#type: &'static str,
    button: Button,
    state: &'static str,
    x: i32,
    y: i32,
}

#[derive(Serialize)]
struct ZoomLine<'a> {
    #[serde(rename = "tUs")]
    t_us: i64,
    r#type: &'static str,
    #[serde(rename = "presetId")]
    preset_id: &'a str,
    action: ZoomAction,
}

#[derive(Serialize)]
struct LayoutLine<'a> {
    #[serde(rename = "tUs")]
    t_us: i64,
    r#type: &'static str,
    layout: &'a str,
}

/// Camera layouts a live hotkey can switch to, in hotkey order (Ctrl+Shift+1 .. Ctrl+Shift+4):
/// corner bubble, side column, camera fullscreen, screen only. Names as in `project.json`.
pub const LAYOUTS: [&str; 4] = ["pip", "side", "camera", "screen"];

#[derive(Serialize)]
struct MarkerLine {
    #[serde(rename = "tUs")]
    t_us: i64,
    r#type: &'static str,
}

/// Appends events to `out`. Write methods never fail the caller: the first I/O error is kept and
/// returned by `flush`, so the capture loop is not interrupted by a log problem.
pub struct EventLog<W: Write> {
    out: W,
    origin: (i32, i32),
    fps: u32,
    last_cursor_slot: Option<i64>,
    last_cursor: Option<(i32, i32)>,
    last_shape: Option<(String, u32)>,
    last_flush_us: i64,
    error: Option<io::Error>,
}

impl<W: Write> EventLog<W> {
    /// Writes and flushes the header line. `origin` is the top-left of the captured region in
    /// screen coordinates; `fps` sets the cursor throttling slots.
    pub fn new(mut out: W, header: EventsHeader, origin: (i32, i32), fps: u32) -> io::Result<Self> {
        let line = HeaderLine {
            r#type: "header",
            version: 1,
            source: Source { width: header.width, height: header.height, fps: header.fps },
            started_at: &header.started_at,
        };
        serde_json::to_writer(&mut out, &line).map_err(io::Error::from)?;
        out.write_all(b"\n")?;
        out.flush()?;
        Ok(Self { out, origin, fps, last_cursor_slot: None, last_cursor: None, last_shape: None, last_flush_us: 0, error: None })
    }

    /// Records a cursor move. At most one line per frame slot (the first move in it), and only
    /// when the position differs from the last cursor line written.
    pub fn cursor(&mut self, rec_us: i64, screen_x: i32, screen_y: i32) {
        let slot = rec_us * i64::from(self.fps) / 1_000_000;
        if self.last_cursor_slot == Some(slot) {
            return;
        }
        let pos = (screen_x - self.origin.0, screen_y - self.origin.1);
        if self.last_cursor == Some(pos) {
            return;
        }
        self.last_cursor_slot = Some(slot);
        self.last_cursor = Some(pos);
        self.write_line(rec_us, &CursorLine { t_us: rec_us, r#type: "cursor", x: pos.0, y: pos.1 });
    }

    /// Records the cursor's shape (one of `CURSOR_SHAPES`) and cell size in captured pixels. Written only
    /// when either differs from the last `cursorShape` line.
    pub fn cursor_shape(&mut self, rec_us: i64, shape: &str, px: u32) {
        if self.last_shape.as_ref().is_some_and(|(s, p)| s == shape && *p == px) {
            return;
        }
        self.last_shape = Some((shape.to_string(), px));
        self.write_line(rec_us, &CursorShapeLine { t_us: rec_us, r#type: "cursorShape", shape, px });
    }

    pub fn click(&mut self, rec_us: i64, button: Button, down: bool, screen_x: i32, screen_y: i32) {
        let line = ClickLine {
            t_us: rec_us,
            r#type: "click",
            button,
            state: if down { "down" } else { "up" },
            x: screen_x - self.origin.0,
            y: screen_y - self.origin.1,
        };
        self.write_line(rec_us, &line);
    }

    /// Both `In` and `Out` carry a preset id; an `Out` line names the zoom being ended.
    pub fn zoom(&mut self, rec_us: i64, preset_id: &str, action: ZoomAction) {
        self.write_line(rec_us, &ZoomLine { t_us: rec_us, r#type: "zoom", preset_id, action });
    }

    /// A live layout switch (one of `LAYOUTS`); the editor turns these into layout scenes.
    pub fn layout(&mut self, rec_us: i64, layout: &str) {
        self.write_line(rec_us, &LayoutLine { t_us: rec_us, r#type: "layout", layout });
    }

    pub fn pause(&mut self, rec_us: i64) {
        self.write_line(rec_us, &MarkerLine { t_us: rec_us, r#type: "pause" });
    }

    pub fn resume(&mut self, rec_us: i64) {
        self.write_line(rec_us, &MarkerLine { t_us: rec_us, r#type: "resume" });
    }

    /// Flushes the writer and returns the first error kept since the last call, if any.
    pub fn flush(&mut self) -> io::Result<()> {
        let flushed = self.out.flush();
        match self.error.take() {
            Some(err) => Err(err),
            None => flushed,
        }
    }

    /// Returns the underlying writer (after a best-effort flush).
    pub fn into_inner(mut self) -> W {
        let _ = self.out.flush();
        self.out
    }

    fn write_line<T: Serialize>(&mut self, rec_us: i64, line: &T) {
        let result = serde_json::to_writer(&mut self.out, line)
            .map_err(io::Error::from)
            .and_then(|()| self.out.write_all(b"\n"));
        if let Err(err) = result {
            self.keep_error(err);
            return;
        }
        if rec_us - self.last_flush_us >= FLUSH_INTERVAL_US {
            match self.out.flush() {
                Ok(()) => self.last_flush_us = rec_us,
                Err(err) => self.keep_error(err),
            }
        }
    }

    fn keep_error(&mut self, err: io::Error) {
        if self.error.is_none() {
            self.error = Some(err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;
    use std::rc::Rc;

    const HEADER_LINE: &str = r#"{"type":"header","version":1,"source":{"width":2560,"height":1440,"fps":60},"startedAt":"2026-11-17T10:00:00Z"}"#;

    fn header() -> EventsHeader {
        EventsHeader { width: 2560, height: 1440, fps: 60, started_at: "2026-11-17T10:00:00Z".to_string() }
    }

    fn new_log(origin: (i32, i32)) -> EventLog<Vec<u8>> {
        EventLog::new(Vec::new(), header(), origin, 60).unwrap()
    }

    fn text(log: EventLog<Vec<u8>>) -> String {
        String::from_utf8(log.into_inner()).unwrap()
    }

    fn lines(s: &str) -> Vec<&str> {
        s.lines().collect()
    }

    #[test]
    fn header_matches_contract() {
        let out = text(new_log((0, 0)));
        assert_eq!(out, format!("{HEADER_LINE}\n"));
        let v: serde_json::Value = serde_json::from_str(out.trim_end()).unwrap();
        assert_eq!(v["type"], "header");
        assert_eq!(v["version"], 1);
        assert_eq!(v["source"]["width"], 2560);
        assert_eq!(v["source"]["height"], 1440);
        assert_eq!(v["source"]["fps"], 60);
        assert_eq!(v["startedAt"], "2026-11-17T10:00:00Z");
    }

    #[test]
    fn cursor_throttled_per_frame() {
        let mut log = new_log((0, 0));
        // 60 fps: slot 0 covers 0..16_666 us. Three moves inside it write only the first.
        log.cursor(1_000, 10, 10);
        log.cursor(5_000, 20, 20);
        log.cursor(16_000, 30, 30);
        // 16_667 us is slot 1.
        log.cursor(16_667, 40, 40);
        let out = text(log);
        assert_eq!(
            lines(&out),
            vec![
                HEADER_LINE,
                r#"{"tUs":1000,"type":"cursor","x":10,"y":10}"#,
                r#"{"tUs":16667,"type":"cursor","x":40,"y":40}"#,
            ]
        );
    }

    #[test]
    fn cursor_shape_written_on_change_only() {
        let mut log = new_log((0, 0));
        log.cursor_shape(1_000, "arrow", 32);
        log.cursor_shape(17_000, "arrow", 32);
        log.cursor_shape(33_000, "hand", 32);
        log.cursor_shape(50_000, "hand", 48);
        let out = text(log);
        assert_eq!(
            lines(&out),
            vec![
                HEADER_LINE,
                r#"{"tUs":1000,"type":"cursorShape","shape":"arrow","px":32}"#,
                r#"{"tUs":33000,"type":"cursorShape","shape":"hand","px":32}"#,
                r#"{"tUs":50000,"type":"cursorShape","shape":"hand","px":48}"#,
            ]
        );
    }

    #[test]
    fn cursor_unchanged_not_written() {
        let mut log = new_log((0, 0));
        log.cursor(16_000, 1203, 644);
        log.cursor(33_000, 1203, 644);
        log.cursor(50_000, 1203, 644);
        let out = text(log);
        assert_eq!(lines(&out), vec![HEADER_LINE, r#"{"tUs":16000,"type":"cursor","x":1203,"y":644}"#]);
    }

    #[test]
    fn unchanged_first_move_does_not_use_up_the_slot() {
        let mut log = new_log((0, 0));
        log.cursor(1_000, 5, 5);
        // Slot 1: same position first (not a move), then a real move in the same slot.
        log.cursor(17_000, 5, 5);
        log.cursor(18_000, 6, 6);
        let out = text(log);
        assert_eq!(
            lines(&out),
            vec![
                HEADER_LINE,
                r#"{"tUs":1000,"type":"cursor","x":5,"y":5}"#,
                r#"{"tUs":18000,"type":"cursor","x":6,"y":6}"#,
            ]
        );
    }

    #[test]
    fn region_origin_subtracted() {
        let mut log = new_log((100, 50));
        log.cursor(16_000, 110, 60);
        log.click(20_000, Button::Left, true, 110, 60);
        let out = text(log);
        assert_eq!(
            lines(&out),
            vec![
                HEADER_LINE,
                r#"{"tUs":16000,"type":"cursor","x":10,"y":10}"#,
                r#"{"tUs":20000,"type":"click","button":"left","state":"down","x":10,"y":10}"#,
            ]
        );
    }

    #[test]
    fn click_lines() {
        let mut log = new_log((0, 0));
        log.click(812_000, Button::Left, true, 1203, 644);
        log.click(903_000, Button::Left, false, 1203, 644);
        log.click(950_000, Button::Right, true, 1, 2);
        log.click(960_000, Button::Middle, false, 3, 4);
        let out = text(log);
        assert_eq!(
            lines(&out),
            vec![
                HEADER_LINE,
                r#"{"tUs":812000,"type":"click","button":"left","state":"down","x":1203,"y":644}"#,
                r#"{"tUs":903000,"type":"click","button":"left","state":"up","x":1203,"y":644}"#,
                r#"{"tUs":950000,"type":"click","button":"right","state":"down","x":1,"y":2}"#,
                r#"{"tUs":960000,"type":"click","button":"middle","state":"up","x":3,"y":4}"#,
            ]
        );
    }

    #[test]
    fn layout_line() {
        let mut log = new_log((0, 0));
        log.layout(4_000_000, LAYOUTS[1]);
        let out = text(log);
        assert_eq!(lines(&out), vec![HEADER_LINE, r#"{"tUs":4000000,"type":"layout","layout":"side"}"#]);
    }

    #[test]
    fn zoom_in_has_preset() {
        let mut log = new_log((0, 0));
        log.zoom(4_100_000, "p1", ZoomAction::In);
        let out = text(log);
        assert_eq!(lines(&out), vec![HEADER_LINE, r#"{"tUs":4100000,"type":"zoom","presetId":"p1","action":"in"}"#]);
    }

    #[test]
    fn zoom_out_names_its_preset() {
        let mut log = new_log((0, 0));
        log.zoom(8_200_000, "p1", ZoomAction::Out);
        let out = text(log);
        assert_eq!(lines(&out), vec![HEADER_LINE, r#"{"tUs":8200000,"type":"zoom","presetId":"p1","action":"out"}"#]);
    }

    #[test]
    fn pause_and_resume_same_tus() {
        let mut log = new_log((0, 0));
        log.pause(9_000_000);
        log.resume(9_000_000);
        let out = text(log);
        assert_eq!(
            lines(&out),
            vec![HEADER_LINE, r#"{"tUs":9000000,"type":"pause"}"#, r#"{"tUs":9000000,"type":"resume"}"#]
        );
    }

    /// Counts flush calls and remembers how many bytes had been written at each one.
    struct Probe {
        flushes: Rc<RefCell<Vec<usize>>>,
        written: Rc<Cell<usize>>,
    }

    impl std::io::Write for Probe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.written.set(self.written.get() + buf.len());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes.borrow_mut().push(self.written.get());
            Ok(())
        }
    }

    #[test]
    fn flushes_at_least_once_per_second() {
        let flushes = Rc::new(RefCell::new(Vec::new()));
        let written = Rc::new(Cell::new(0));
        let probe = Probe { flushes: flushes.clone(), written: written.clone() };
        let mut log = EventLog::new(probe, header(), (0, 0), 60).unwrap();
        assert_eq!(flushes.borrow().len(), 1, "the header is flushed on creation");

        log.pause(500_000);
        log.pause(999_999);
        assert_eq!(flushes.borrow().len(), 1, "under a second since the last flush: no flush");

        log.pause(1_000_000);
        assert_eq!(flushes.borrow().len(), 2, "a second after the last flush: flush");
        assert_eq!(*flushes.borrow().last().unwrap(), written.get(), "the flush includes the line that triggered it");

        log.pause(1_500_000);
        assert_eq!(flushes.borrow().len(), 2, "the clock restarts at the last flush");
        log.pause(2_000_000);
        assert_eq!(flushes.borrow().len(), 3);

        log.flush().unwrap();
        assert_eq!(flushes.borrow().len(), 4, "flush() always flushes");
    }

    fn fixture_text() -> String {
        let mut log = EventLog::new(
            Vec::new(),
            EventsHeader { width: 2560, height: 1440, fps: 60, started_at: "2026-11-17T10:00:00Z".to_string() },
            (0, 0),
            60,
        )
        .unwrap();
        log.cursor(16_000, 1203, 644);
        log.cursor(33_000, 1210, 650);
        log.click(812_000, Button::Left, true, 1210, 650);
        log.click(903_000, Button::Left, false, 1210, 650);
        log.click(1_200_000, Button::Right, true, 640, 360);
        log.click(1_250_000, Button::Right, false, 640, 360);
        log.zoom(4_100_000, "p1", ZoomAction::In);
        log.zoom(8_200_000, "p1", ZoomAction::Out);
        log.pause(9_000_000);
        log.resume(9_000_000);
        log.flush().unwrap();
        String::from_utf8(log.into_inner()).unwrap()
    }

    /// The committed fixture is read by the editor's Vitest suite (`parses the Rust writer fixture`),
    /// so it must be exactly what the writer produces. Regenerate with `MARZ_UPDATE_FIXTURES=1`.
    #[test]
    fn fixture_matches_writer_output() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/events-sample.jsonl");
        let generated = fixture_text();
        if std::env::var_os("MARZ_UPDATE_FIXTURES").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &generated).unwrap();
        }
        let committed = std::fs::read_to_string(&path).expect("fixture missing: run with MARZ_UPDATE_FIXTURES=1");
        assert_eq!(generated, committed.replace("\r\n", "\n"), "events-sample.jsonl drifted from the writer");
    }
}
