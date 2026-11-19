//! The whisper.cpp CLI: its arguments, finding the binary, and reading its word JSON (`-ojf`).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::transcript::Word;

/// Prompt that keeps Whisper from dropping fillers (measured in the AI spike).
pub const FILLER_PROMPT: &str = "Umm, uh, é, ããã, tipo, né. So, um, like.";

/// Arguments for one section: one word per segment (`-ml 1 -sow`), full JSON (`-ojf`), VAD when a
/// VAD model is given (without it Whisper invents words over silence and times drift after pauses).
/// Writes `<out_base>.json`.
pub fn whisper_args(model: &Path, vad_model: Option<&Path>, wav: &Path, out_base: &Path, language: Option<&str>, prompt: &str) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-m".into(),
        model.display().to_string(),
        "-f".into(),
        wav.display().to_string(),
        "-l".into(),
        language.unwrap_or("auto").to_string(),
        "-ojf".into(),
        "-ml".into(),
        "1".into(),
        "-sow".into(),
    ];
    if !prompt.is_empty() {
        a.push("--prompt".into());
        a.push(prompt.to_string());
    }
    if let Some(vad) = vad_model {
        a.push("--vad".into());
        a.push("-vm".into());
        a.push(vad.display().to_string());
    }
    a.push("-of".into());
    a.push(out_base.display().to_string());
    a.push("-np".into());
    a
}

/// Reads whisper.cpp `-ojf` output made with `-ml 1 -sow` (one word per segment). Returns the
/// detected language (`"und"` when missing) and the words, ids `w{n}` from `id_start`, times in
/// microseconds of source time: `ms * 1000 + section_start_us + mic_offset_us`.
///
/// Skips segments with empty text, text starting with `[` (`[_BEG_]`, `[BLANK_AUDIO]`) and
/// segments with `to <= from`. A word's `p` is the mean `p` of its tokens, `[_...]` tokens excluded.
pub fn parse_whisper_json(json: &str, section_start_us: i64, mic_offset_us: i64, id_start: usize) -> Result<(String, Vec<Word>), String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("whisper JSON does not parse: {e}"))?;
    let language = v
        .pointer("/result/language")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("und")
        .to_string();
    let segments = v
        .get("transcription")
        .and_then(Value::as_array)
        .ok_or_else(|| "whisper JSON has no transcription".to_string())?;
    let base = section_start_us + mic_offset_us;
    let mut words = Vec::new();
    for seg in segments {
        let text = seg.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() || text.starts_with('[') {
            continue;
        }
        let from = seg.pointer("/offsets/from").and_then(Value::as_i64);
        let to = seg.pointer("/offsets/to").and_then(Value::as_i64);
        let (Some(from), Some(to)) = (from, to) else { continue };
        if to <= from {
            continue;
        }
        let ps: Vec<f64> = seg
            .get("tokens")
            .and_then(Value::as_array)
            .map(|toks| {
                toks.iter()
                    .filter(|t| !t.get("text").and_then(Value::as_str).unwrap_or("").starts_with("[_"))
                    .filter_map(|t| t.get("p").and_then(Value::as_f64))
                    .collect()
            })
            .unwrap_or_default();
        let p = if ps.is_empty() { 0.0 } else { ps.iter().sum::<f64>() / ps.len() as f64 };
        words.push(Word {
            id: format!("w{}", id_start + words.len()),
            text: text.to_string(),
            start_us: from * 1000 + base,
            end_us: to * 1000 + base,
            p: (p * 10_000.0).round() / 10_000.0,
        });
    }
    Ok((language, words))
}

/// Finds `whisper-cli`: `MARZ_WHISPER`, then beside the exe and in `<exe_dir>/whisper/`, then
/// `<app_data>/whisper/` (and its `Release/`), then PATH. A set `MARZ_WHISPER` that points nowhere
/// gives `None`, never a silent fall-through.
pub fn find_whisper(exe_dir: Option<&Path>, app_data: Option<&Path>) -> Option<PathBuf> {
    let env_override = std::env::var_os("MARZ_WHISPER").filter(|v| !v.is_empty());
    let path_var = std::env::var_os("PATH");
    find_whisper_in(env_override.as_deref(), exe_dir, app_data, path_var.as_deref())
}

/// [`find_whisper`] with the environment passed in.
pub fn find_whisper_in(env_override: Option<&OsStr>, exe_dir: Option<&Path>, app_data: Option<&Path>, path_var: Option<&OsStr>) -> Option<PathBuf> {
    if let Some(p) = env_override {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    const EXE: &str = "whisper-cli.exe";
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(dir.join(EXE));
        candidates.push(dir.join("whisper").join(EXE));
    }
    if let Some(dir) = app_data {
        candidates.push(dir.join("whisper").join(EXE));
        candidates.push(dir.join("whisper").join("Release").join(EXE));
    }
    if let Some(found) = candidates.into_iter().find(|c| c.is_file()) {
        return Some(found);
    }
    let path_var = path_var?;
    for dir in std::env::split_paths(path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in [EXE, "whisper-cli"] {
            let c = dir.join(name);
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Tests that change the process environment hold this.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn fixture(name: &str) -> String {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name);
        std::fs::read_to_string(p).unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marz-whisper-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn args_match_the_spike_command() {
        let a = whisper_args(Path::new("m.bin"), Some(Path::new("vad.bin")), Path::new("s1.wav"), Path::new("s1"), None, FILLER_PROMPT);
        let want: Vec<String> = [
            "-m", "m.bin", "-f", "s1.wav", "-l", "auto", "-ojf", "-ml", "1", "-sow", "--prompt", FILLER_PROMPT, "--vad", "-vm", "vad.bin",
            "-of", "s1", "-np",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(a, want);
        let b = whisper_args(Path::new("m.bin"), None, Path::new("s1.wav"), Path::new("s1"), Some("pt"), "");
        assert!(b.windows(2).any(|w| w[0] == "-l" && w[1] == "pt"));
        assert!(!b.iter().any(|x| x == "--vad" || x == "--prompt"));
    }

    #[test]
    fn parses_whisper_word_json_and_adds_offsets() {
        let (lang, words) = parse_whisper_json(&fixture("v_vad.json"), 2_000_000, 500_000, 1).unwrap();
        assert_eq!(lang, "pt");
        // 40 segments in the fixture, the first is `[_BEG_]` with empty text.
        assert_eq!(words.len(), 39);
        let w = &words[0];
        assert_eq!(w.id, "w1");
        assert_eq!(w.text, "Não,");
        assert_eq!(w.start_us, 4_140_000 + 2_000_000 + 500_000);
        assert_eq!(w.end_us, 4_360_000 + 2_000_000 + 500_000);
        assert!(w.p > 0.5 && w.p <= 1.0);
        assert_eq!(words[1].text, "mas");
        assert_eq!(words.last().unwrap().id, "w39");
        assert!(words.iter().all(|w| w.end_us > w.start_us));
    }

    #[test]
    fn skips_bracket_tokens_and_empty_text() {
        let (lang, words) = parse_whisper_json(&fixture("full_vad_1935.json"), 0, 0, 0).unwrap();
        assert_eq!(lang, "pt");
        assert!(words.iter().all(|w| !w.text.is_empty() && !w.text.starts_with('[')));
        // Two `[_BEG_]` segments in the fixture.
        assert_eq!(words.len(), 34 - 2);
        // " bom." has tokens bom (0.999167), . (0.778244) and [_TT_1476] (excluded).
        let bom = words.iter().find(|w| w.text == "bom.").unwrap();
        assert!((bom.p - (0.999167 + 0.778244) / 2.0).abs() < 1e-4, "p = {}", bom.p);

        let synthetic = r#"{"result":{"language":"en"},"transcription":[
            {"offsets":{"from":0,"to":100},"text":" [BLANK_AUDIO]","tokens":[]},
            {"offsets":{"from":100,"to":200},"text":"   ","tokens":[]},
            {"offsets":{"from":300,"to":300},"text":" zero","tokens":[]},
            {"offsets":{"from":400,"to":350},"text":" back","tokens":[]},
            {"offsets":{"from":500,"to":700},"text":" ok","tokens":[{"text":"[_BEG_]","p":0.1},{"text":" ok","p":0.8}]}
        ]}"#;
        let (lang, words) = parse_whisper_json(synthetic, 0, 0, 7).unwrap();
        assert_eq!(lang, "en");
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].id, "w7");
        assert_eq!(words[0].p, 0.8);
        assert!(parse_whisper_json("{}", 0, 0, 0).is_err());
        assert!(parse_whisper_json("not json", 0, 0, 0).is_err());
    }

    #[test]
    fn find_whisper_search_order() {
        let exe = temp_dir("exe");
        let app = temp_dir("app");
        let path = temp_dir("path");
        assert_eq!(find_whisper_in(None, Some(&exe), Some(&app), Some(path.as_os_str())), None);

        std::fs::write(path.join("whisper-cli"), b"").unwrap();
        assert_eq!(find_whisper_in(None, Some(&exe), Some(&app), Some(path.as_os_str())), Some(path.join("whisper-cli")));

        std::fs::create_dir_all(app.join("whisper").join("Release")).unwrap();
        let app_release = app.join("whisper").join("Release").join("whisper-cli.exe");
        std::fs::write(&app_release, b"").unwrap();
        assert_eq!(find_whisper_in(None, Some(&exe), Some(&app), Some(path.as_os_str())), Some(app_release));

        std::fs::create_dir_all(exe.join("whisper")).unwrap();
        let exe_sub = exe.join("whisper").join("whisper-cli.exe");
        std::fs::write(&exe_sub, b"").unwrap();
        assert_eq!(find_whisper_in(None, Some(&exe), Some(&app), Some(path.as_os_str())), Some(exe_sub));

        let beside = exe.join("whisper-cli.exe");
        std::fs::write(&beside, b"").unwrap();
        assert_eq!(find_whisper_in(None, Some(&exe), Some(&app), Some(path.as_os_str())), Some(beside));

        // An override that points nowhere is not found, even with whisper beside the exe.
        let missing = exe.join("nope.exe");
        assert_eq!(find_whisper_in(Some(missing.as_os_str()), Some(&exe), Some(&app), None), None);
    }

    #[test]
    fn find_whisper_honours_marz_whisper() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("env");
        let custom = dir.join("my-whisper.exe");
        std::fs::write(&custom, b"").unwrap();
        std::fs::write(dir.join("whisper-cli.exe"), b"").unwrap();
        let before = std::env::var_os("MARZ_WHISPER");
        // SAFETY: the only test that changes the environment, serialised by ENV_LOCK.
        unsafe { std::env::set_var("MARZ_WHISPER", &custom) };
        let found = find_whisper(Some(&dir), None);
        unsafe {
            match &before {
                Some(v) => std::env::set_var("MARZ_WHISPER", v),
                None => std::env::remove_var("MARZ_WHISPER"),
            }
        }
        assert_eq!(found, Some(custom));
    }
}
