//! Writer for `project.json` and the live zoom blocks derived from zoom hotkey marks.
//!
//! Field names and order follow the spec example in
//! `docs/superpowers/specs/2026-11-15-milestone-1-design.md`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

/// A rectangle in normalized 0 to 1 coordinates of the source frame.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct NormRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ZoomPreset {
    pub id: String,
    pub name: String,
    pub rect: NormRect,
}

/// A zoom hotkey press on the recording clock. `preset_id: None` is a zoom out.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveZoomMark {
    pub t_us: i64,
    pub preset_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MicMeta {
    pub offset_us: i64,
}

/// Everything `project.json` needs. The crash marker stores this as JSON, with duration, offsets
/// and zooms left at their start-of-recording values.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub duration_us: i64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub screen_offset_us: i64,
    pub mic: Option<MicMeta>,
    pub cursor_hidden: bool,
    pub presets: Vec<ZoomPreset>,
    pub zooms: Vec<Value>,
}

/// Ease length for live zooms, both ways.
const EASE_US: i64 = 400_000;

/// Turn zoom hotkey marks into zoom blocks. A mark with a preset starts a zoom that ends at the
/// next mark (out or another preset) or at `duration_us`. Zero-length zooms and unknown presets
/// are dropped, and ids count only the zooms that are kept.
pub fn live_zooms(marks: &[LiveZoomMark], presets: &[ZoomPreset], duration_us: i64) -> Vec<Value> {
    let mut zooms = Vec::new();
    for (i, m) in marks.iter().enumerate() {
        let Some(preset_id) = &m.preset_id else { continue };
        let Some(preset) = presets.iter().find(|p| &p.id == preset_id) else { continue };
        let start = m.t_us.max(0);
        let end = marks.get(i + 1).map_or(duration_us, |next| next.t_us).min(duration_us);
        if end <= start {
            continue;
        }
        zooms.push(json!({
            "id": format!("live-{}", zooms.len() + 1),
            "startUs": start,
            "endUs": end,
            "rect": preset.rect,
            "easeInUs": EASE_US,
            "easeOutUs": EASE_US,
            "easing": "easeInOutCubic",
            "origin": "live",
        }));
    }
    zooms
}

/// The `project.json` document for a recording (version 1).
pub fn project_json(meta: &ProjectMeta) -> Value {
    let mut tracks = json!({ "screen": { "file": "screen.mp4", "offsetUs": meta.screen_offset_us } });
    if let Some(mic) = &meta.mic {
        tracks["mic"] = json!({ "file": "mic.wav", "offsetUs": mic.offset_us, "volume": 1, "muted": false });
    }
    json!({
        "version": 1,
        "id": meta.id,
        "name": meta.name,
        "createdAt": meta.created_at,
        "durationUs": meta.duration_us,
        "source": { "width": meta.width, "height": meta.height, "fps": meta.fps },
        "tracks": tracks,
        "output": { "width": 1920, "height": 1080, "fps": meta.fps },
        "zoomPresets": meta.presets,
        "edits": {
            "zooms": meta.zooms,
            "cuts": [],
            "cursor": { "hidden": meta.cursor_hidden },
            "clicks": { "effect": "none" },
        },
    })
}

/// Write `project.json` through `project.json.tmp` and a rename, so a crash never leaves a
/// half-written file under the real name.
pub fn write_project_json(dir: &Path, meta: &ProjectMeta) -> io::Result<()> {
    let text = serde_json::to_string_pretty(&project_json(meta)).map_err(io::Error::other)? + "
";
    let tmp = dir.join("project.json.tmp");
    let mut file = File::create(&tmp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, dir.join("project.json"))
}

/// RFC 3339 UTC at second precision (`createdAt`, `startedAt`) for seconds since the Unix epoch.
pub fn iso_utc(unix_secs: i64) -> String {
    let (days, rem) = (unix_secs.div_euclid(86_400), unix_secs.rem_euclid(86_400));
    let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `iso_utc` for now.
pub fn iso_utc_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    iso_utc(secs)
}

/// Name of the file that marks a recording in progress.
pub const CRASH_MARKER: &str = ".recording";

/// Write the crash marker: the `ProjectMeta` known at start (duration, offsets and zooms still empty).
pub fn write_crash_marker(dir: &Path, meta: &ProjectMeta) -> io::Result<()> {
    let text = serde_json::to_string_pretty(meta).map_err(io::Error::other)?;
    std::fs::write(dir.join(CRASH_MARKER), text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn preset(id: &str, x: f64) -> ZoomPreset {
        ZoomPreset { id: id.into(), name: format!("Preset {id}"), rect: NormRect { x, y: 0.1, w: 0.5, h: 0.5 } }
    }

    fn mark(t_us: i64, id: Option<&str>) -> LiveZoomMark {
        LiveZoomMark { t_us, preset_id: id.map(str::to_string) }
    }

    fn sample_meta() -> ProjectMeta {
        let presets = vec![preset("p1", 0.1)];
        let zooms = live_zooms(&[mark(4_100_000, Some("p1")), mark(8_200_000, None)], &presets, 63_500_000);
        ProjectMeta {
            id: "6f1c2a9e-0000-4000-8000-000000000001".into(),
            name: "My Recording".into(),
            created_at: "2026-11-15T19:00:00Z".into(),
            duration_us: 63_500_000,
            width: 2560,
            height: 1440,
            fps: 60,
            screen_offset_us: 0,
            mic: Some(MicMeta { offset_us: 12_400 }),
            cursor_hidden: false,
            presets,
            zooms,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("marz-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn iso_utc_formats_known_instants() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(1_794_915_045), "2026-11-17T11:30:45Z");
    }

    #[test]
    fn project_json_parses_as_contract() {
        let text = serde_json::to_string_pretty(&project_json(&sample_meta())).unwrap() + "\n";
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["id"], "6f1c2a9e-0000-4000-8000-000000000001");
        assert_eq!(v["durationUs"], 63_500_000);
        assert_eq!(v["source"], serde_json::json!({"width": 2560, "height": 1440, "fps": 60}));
        assert_eq!(v["tracks"]["screen"], serde_json::json!({"file": "screen.mp4", "offsetUs": 0}));
        assert_eq!(v["tracks"]["mic"], serde_json::json!({"file": "mic.wav", "offsetUs": 12400, "volume": 1, "muted": false}));
        assert_eq!(v["output"], serde_json::json!({"width": 1920, "height": 1080, "fps": 60}));
        assert_eq!(v["zoomPresets"][0]["rect"], serde_json::json!({"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5}));
        assert_eq!(v["edits"]["cuts"], serde_json::json!([]));
        assert_eq!(v["edits"]["cursor"], serde_json::json!({"hidden": false}));
        assert_eq!(v["edits"]["clicks"], serde_json::json!({"effect": "none"}));
        let z = &v["edits"]["zooms"][0];
        assert_eq!(z["id"], "live-1");
        assert_eq!(z["startUs"], 4_100_000);
        assert_eq!(z["endUs"], 8_200_000);
        assert_eq!(z["origin"], "live");
        // Field order follows the spec example.
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["version", "id", "name", "createdAt", "durationUs", "source", "tracks", "output", "zoomPresets", "edits"]);
        let zkeys: Vec<&str> = z.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(zkeys, ["id", "startUs", "endUs", "rect", "easeInUs", "easeOutUs", "easing", "origin"]);
    }

    #[test]
    fn no_mic_omits_track() {
        let mut meta = sample_meta();
        meta.mic = None;
        let v = project_json(&meta);
        assert!(v["tracks"].as_object().unwrap().get("mic").is_none());
        assert!(v["tracks"]["screen"].is_object());
    }

    #[test]
    fn cursor_hidden_is_written() {
        let mut meta = sample_meta();
        meta.cursor_hidden = true;
        assert_eq!(project_json(&meta)["edits"]["cursor"]["hidden"], true);
    }

    #[test]
    fn live_zoom_pairs_in_and_out() {
        let z = live_zooms(&[mark(1_000, Some("p1")), mark(5_000, None)], &[preset("p1", 0.1)], 10_000);
        assert_eq!(z.len(), 1);
        assert_eq!(z[0]["startUs"], 1_000);
        assert_eq!(z[0]["endUs"], 5_000);
        assert_eq!(z[0]["easeInUs"], 400_000);
        assert_eq!(z[0]["easeOutUs"], 400_000);
        assert_eq!(z[0]["easing"], "easeInOutCubic");
        assert_eq!(z[0]["rect"]["x"], 0.1);
    }

    #[test]
    fn live_zoom_preset_to_preset() {
        let presets = [preset("p1", 0.1), preset("p2", 0.3)];
        let z = live_zooms(&[mark(1_000, Some("p1")), mark(4_000, Some("p2")), mark(9_000, None)], &presets, 10_000);
        assert_eq!(z.len(), 2);
        assert_eq!((z[0]["id"].as_str(), z[0]["startUs"].as_i64(), z[0]["endUs"].as_i64()), (Some("live-1"), Some(1_000), Some(4_000)));
        assert_eq!((z[1]["id"].as_str(), z[1]["startUs"].as_i64(), z[1]["endUs"].as_i64()), (Some("live-2"), Some(4_000), Some(9_000)));
        assert_eq!(z[1]["rect"]["x"], 0.3);
    }

    #[test]
    fn live_zoom_open_until_stop() {
        let z = live_zooms(&[mark(1_000, Some("p1"))], &[preset("p1", 0.1)], 7_000);
        assert_eq!(z.len(), 1);
        assert_eq!(z[0]["endUs"], 7_000);
    }

    #[test]
    fn live_zoom_drops_empty_and_unknown() {
        let presets = [preset("p1", 0.1)];
        // Zero length (in and out at the same instant), unknown preset, and a mark past the end.
        let marks = [mark(2_000, Some("p1")), mark(2_000, None), mark(3_000, Some("nope")), mark(4_000, None), mark(12_000, Some("p1"))];
        let z = live_zooms(&marks, &presets, 10_000);
        assert!(z.is_empty(), "{z:?}");
        // Ids count only the zooms that were kept.
        let z = live_zooms(&[mark(1_000, Some("nope")), mark(2_000, Some("p1"))], &presets, 10_000);
        assert_eq!(z[0]["id"], "live-1");
    }

    #[test]
    fn write_is_atomic() {
        let dir = temp_dir("project-atomic");
        // A half-written tmp file left behind by a crash must not leak into the result.
        std::fs::write(dir.join("project.json.tmp"), "{\"half\":").unwrap();
        std::fs::write(dir.join("project.json"), "{\"old\":true}").unwrap();
        write_project_json(&dir, &sample_meta()).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert!(v.get("old").is_none());
        assert!(!dir.join("project.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crash_marker_round_trips() {
        let dir = temp_dir("project-marker");
        let meta = sample_meta();
        write_crash_marker(&dir, &meta).unwrap();
        let back: ProjectMeta = serde_json::from_str(&std::fs::read_to_string(dir.join(CRASH_MARKER)).unwrap()).unwrap();
        assert_eq!(back, meta);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The committed fixture is read by the editor's Vitest suite (`parses the Rust project fixture`),
    /// so it must be exactly what the writer produces. Regenerate with `MARZ_UPDATE_FIXTURES=1`.
    #[test]
    fn fixture_matches_writer_output() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/project-sample.json");
        let generated = serde_json::to_string_pretty(&project_json(&sample_meta())).unwrap() + "\n";
        if std::env::var_os("MARZ_UPDATE_FIXTURES").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &generated).unwrap();
        }
        let committed = std::fs::read_to_string(&path).expect("fixture missing: run with MARZ_UPDATE_FIXTURES=1");
        assert_eq!(generated, committed.replace("\r\n", "\n"), "project-sample.json drifted from the writer");
    }
}
