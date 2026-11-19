//! `transcript.json`: the same shape as `Transcript` in `packages/format/src/transcript.ts`.

use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const TRANSCRIPT_FILE: &str = "transcript.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub id: String,
    pub text: String,
    pub start_us: i64,
    pub end_us: i64,
    pub p: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub start_us: i64,
    pub end_us: i64,
    pub language: String,
}

/// Size and modified time of `mic.wav` when it was transcribed, so a changed mic track is noticed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicStamp {
    pub bytes: u64,
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// Always 1.
    pub version: u32,
    pub engine: String,
    pub mic: MicStamp,
    #[serde(default)]
    pub sections: Vec<Section>,
    #[serde(default)]
    pub words: Vec<Word>,
}

/// Writes `<dir>/transcript.json` atomically: `transcript.json.tmp` first, then a rename over it.
pub fn write_transcript(dir: &Path, t: &Transcript) -> io::Result<()> {
    let tmp = dir.join(format!("{TRANSCRIPT_FILE}.tmp"));
    let mut json = serde_json::to_string_pretty(t).map_err(io::Error::other)?;
    json.push('\n');
    fs::write(&tmp, json)?;
    // On Windows `rename` replaces an existing file (MoveFileEx with REPLACE_EXISTING).
    fs::rename(&tmp, dir.join(TRANSCRIPT_FILE)).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Reads `<dir>/transcript.json`, or `None` when it is missing or does not parse.
pub fn read_transcript(dir: &Path) -> Option<Transcript> {
    let text = fs::read_to_string(dir.join(TRANSCRIPT_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Size and modified time (RFC 3339 UTC, whole seconds) of the mic track.
pub fn mic_stamp(mic: &Path) -> io::Result<MicStamp> {
    let meta = fs::metadata(mic)?;
    Ok(MicStamp { bytes: meta.len(), modified_at: rfc3339_utc(meta.modified()?) })
}

/// True when `transcript.json` parses and was made from the mic track as it is now.
pub fn transcript_is_current(dir: &Path, mic: &Path) -> bool {
    match (read_transcript(dir), mic_stamp(mic)) {
        (Some(t), Ok(stamp)) => t.mic == stamp,
        _ => false,
    }
}

/// `2026-11-17T19:00:00Z` from a `SystemTime` (times before 1970 clamp to the epoch).
pub fn rfc3339_utc(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-transcript-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(mic: MicStamp) -> Transcript {
        Transcript {
            version: 1,
            engine: "whisper.cpp ggml-large-v3-turbo-q5_0".into(),
            mic,
            sections: vec![Section { start_us: 0, end_us: 2_000_000, language: "pt".into() }],
            words: vec![Word { id: "w1".into(), text: "Olá,".into(), start_us: 100_000, end_us: 400_000, p: 0.93 }],
        }
    }

    #[test]
    fn formats_utc_by_hand() {
        assert_eq!(rfc3339_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(UNIX_EPOCH + Duration::from_secs(1_795_460_400)), "2026-11-23T19:00:00Z");
        assert_eq!(rfc3339_utc(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(UNIX_EPOCH + Duration::from_secs(1_735_689_599)), "2024-12-31T23:59:59Z");
    }

    #[test]
    fn json_is_camel_case_like_the_ts_format() {
        let t = sample(MicStamp { bytes: 10, modified_at: "2026-11-17T19:00:00Z".into() });
        let v: serde_json::Value = serde_json::to_value(&t).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["mic"]["modifiedAt"], "2026-11-17T19:00:00Z");
        assert_eq!(v["sections"][0]["startUs"], 0);
        assert_eq!(v["words"][0]["endUs"], 400_000);
        assert_eq!(v["words"][0]["p"], 0.93);
    }

    #[test]
    fn writes_atomically() {
        let dir = temp_dir("atomic");
        let t = sample(MicStamp { bytes: 1, modified_at: "2026-11-17T19:00:00Z".into() });
        write_transcript(&dir, &t).unwrap();
        // A second write replaces the first.
        let mut t2 = t.clone();
        t2.words.clear();
        write_transcript(&dir, &t2).unwrap();
        assert!(!dir.join("transcript.json.tmp").exists());
        assert_eq!(read_transcript(&dir), Some(t2));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_is_current_only_when_mic_matches() {
        let dir = temp_dir("current");
        let mic = dir.join("mic.wav");
        fs::write(&mic, vec![0u8; 100]).unwrap();
        assert!(!transcript_is_current(&dir, &mic), "no transcript yet");

        write_transcript(&dir, &sample(mic_stamp(&mic).unwrap())).unwrap();
        assert!(transcript_is_current(&dir, &mic));

        // Different size.
        fs::write(&mic, vec![0u8; 101]).unwrap();
        assert!(!transcript_is_current(&dir, &mic));

        // Same size, different modified time.
        write_transcript(&dir, &sample(mic_stamp(&mic).unwrap())).unwrap();
        let f = fs::File::options().write(true).open(&mic).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(3600)).unwrap();
        drop(f);
        assert!(!transcript_is_current(&dir, &mic));

        // Broken JSON, missing mic.
        fs::write(dir.join("transcript.json"), "{").unwrap();
        assert!(!transcript_is_current(&dir, &mic));
        assert!(!transcript_is_current(&dir, &dir.join("missing.wav")));
        let _ = fs::remove_dir_all(&dir);
    }
}
