//! AI checklist while recording (docs/superpowers/specs/2026-11-19-ai-checklist-design.md): the
//! topics, their ticks, the live transcription thread and the rate-limited Claude ask. The
//! overlay page matches the words (`packages/autoedit/src/checklist.ts`) and ticks through
//! `checklist_tick`; Ctrl+Shift+K ticks the next open topic here.

use crate::ai::{self, AiError, AiRun};
use marz_capture::events::{ChecklistTopic, CHECKLIST_BY};
use serde::Serialize;
use tauri::State;

/// Words for the overlay page, in recording time.
pub const WORDS_EVENT: &str = "checklist://words";
/// Topics per recording and characters per topic (as `splitTopics` in the page).
pub const MAX_TOPICS: usize = 12;
pub const MAX_TEXT: usize = 120;

/// The topics from the setup: trimmed, empty ones dropped, 12 of 120 characters, ids c1..c12.
pub fn topics(raw: &[String]) -> Vec<ChecklistTopic> {
    raw.iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .take(MAX_TOPICS)
        .enumerate()
        .map(|(i, t)| ChecklistTopic { id: format!("c{}", i + 1), text: t.chars().take(MAX_TEXT).collect() })
        .collect()
}

/// One topic as the bar and the overlay show it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub id: String,
    pub text: String,
    /// Recording time it was covered; None while open.
    pub at_us: Option<i64>,
    pub by: Option<String>,
}

pub fn items_of(topics: &[ChecklistTopic]) -> Vec<CheckItem> {
    topics.iter().map(|t| CheckItem { id: t.id.clone(), text: t.text.clone(), at_us: None, by: None }).collect()
}

/// Tick topic `id` (None: the first open one) at `at_us` (None or later than now: now; never
/// below 0). Returns the topic id and time to log, or None when there is nothing to tick (unknown,
/// already ticked, all ticked, or an unknown `by`).
pub fn tick(items: &mut [CheckItem], id: Option<&str>, at_us: Option<i64>, by: &str, now_us: i64) -> Option<(String, i64)> {
    if !CHECKLIST_BY.contains(&by) {
        return None;
    }
    let item = match id {
        Some(id) => items.iter_mut().find(|i| i.id == id)?,
        None => items.iter_mut().find(|i| i.at_us.is_none())?,
    };
    if item.at_us.is_some() {
        return None;
    }
    let at = at_us.unwrap_or(now_us).clamp(0, now_us.max(0));
    item.at_us = Some(at);
    item.by = Some(by.to_string());
    Some((item.id.clone(), at))
}

/// Why the topics cannot tick by listening (shown on the overlay), or None when they can.
pub const NOTE_NO_MIC: &str = "No microphone";
pub const NOTE_NO_WHISPER: &str = "Whisper is missing";
pub const NOTE_NO_MODEL: &str = "The transcription model is missing";

/// Tick a topic: `id` None ticks the first open one. `by` is "auto", "ai" or "hand".
#[tauri::command]
pub fn checklist_tick(app: tauri::AppHandle, id: Option<String>, at_us: Option<i64>, by: String) -> Result<(), String> {
    crate::recording::checklist_tick(&app, id.as_deref(), at_us, &by)
}

/// The Claude run of the checklist, apart from the editor's AI pass so neither cancels the other.
#[derive(Default)]
pub struct ChecklistAi(AiRun);

/// Model for the live ask: small and quick (only a few lines of text go in).
const AI_MODEL: &str = "haiku";

/// Ask Claude Code which open topics the transcript covered. Only the prompt text goes in.
#[tauri::command(async)]
pub fn checklist_ai(run: State<'_, ChecklistAi>, prompt: String, schema: String) -> Result<String, AiError> {
    let claude = ai::find_claude().ok_or(AiError::NotInstalled)?;
    ai::run_claude(&run.0, &claude, &prompt, &schema, AI_MODEL, "")
}

pub fn cancel_ai(run: &ChecklistAi) {
    ai::cancel_run(&run.0);
}

#[cfg(windows)]
pub mod live {
    //! The live transcription thread: reads `mic.wav` (or `MARZ_CHECKLIST_FEED`) as it grows,
    //! cuts chunks, runs Whisper on the spoken ones and sends the words to the overlay.
    use super::WORDS_EVENT;
    use crate::recorder::OVERLAY;
    use marz_transcribe::live::{chunk_for_whisper, transcribe_chunk, ChunkPlanner, GrowingWav, LiveWhisper, MIC_RATE};
    use marz_transcribe::run::append_words;
    use marz_transcribe::Word;
    use serde::Serialize;
    use std::path::PathBuf;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    const POLL: Duration = Duration::from_millis(500);

    /// Debug builds log the live pass to stderr (checks without a person at the mic).
    macro_rules! dlog {
        ($($t:tt)*) => {
            if cfg!(debug_assertions) {
                eprintln!("[checklist] {}", format!($($t)*));
            }
        };
    }

    pub enum Source {
        /// The engine's `mic.wav`; its first sample is at the session's `mic_first_rec_us`.
        Mic(PathBuf),
        /// A test WAV released at recording speed from recording time 0.
        Feed(PathBuf),
    }

    pub struct Setup {
        pub source: Source,
        pub whisper: PathBuf,
        pub model: PathBuf,
        pub vad: Option<PathBuf>,
        pub prompt: String,
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct LiveWordDto {
        text: String,
        start_us: i64,
        end_us: i64,
    }

    #[derive(Serialize, Clone)]
    struct WordsPayload {
        words: Vec<LiveWordDto>,
    }

    /// `alive()` false ends the thread; `clock()` is (recording time now, mic first sample time).
    pub fn run(app: AppHandle, setup: Setup, alive: impl Fn() -> bool, clock: impl Fn() -> Option<(i64, Option<i64>)>) {
        // One folder per run: an old run that is still ending must not delete the next one's files.
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let work = std::env::temp_dir().join(format!("marz-checklist-{}-{nanos}", std::process::id()));
        if std::fs::create_dir_all(&work).is_err() {
            return;
        }
        let (path, feed) = match &setup.source {
            Source::Mic(p) => (p.clone(), false),
            Source::Feed(p) => (p.clone(), true),
        };
        let mut wav = GrowingWav::new(&path);
        let mut planner: Option<ChunkPlanner> = None;
        let mut released: i64 = 0; // feed: samples handed to the planner
        let mut kept: Vec<Word> = Vec::new();
        dlog!("live start: {} ({})", path.display(), if feed { "feed" } else { "mic" });
        let w = LiveWhisper { whisper: &setup.whisper, model: &setup.model, vad: setup.vad.as_deref(), work: &work, prompt: &setup.prompt };
        while alive() {
            std::thread::sleep(POLL);
            let Some((now_us, mic_first)) = clock() else { continue };
            let first = if feed { 0 } else { match mic_first { Some(f) => f, None => continue } };
            // Feed: only what the recording clock has reached.
            let max_frames = if feed {
                let rate = wav.layout().map_or(MIC_RATE, |l| l.rate);
                let due = now_us * i64::from(rate) / 1_000_000;
                (due - released).max(0) as usize
            } else {
                usize::MAX
            };
            let pcm = match wav.read_new(max_frames.min(64 * MIC_RATE as usize)) {
                Ok(p) => p,
                Err(e) => {
                    dlog!("read failed: {e}");
                    continue;
                }
            };
            released += pcm.len() as i64;
            let Some(layout) = wav.layout() else { continue };
            let pl = planner.get_or_insert_with(|| ChunkPlanner::new(layout.rate));
            pl.push(&pcm);
            while let Some(chunk) = pl.next(false) {
                if !alive() {
                    break;
                }
                let Some(pcm16) = chunk_for_whisper(&chunk.pcm, layout.rate) else {
                    dlog!("chunk at {} us: silence", chunk.start_us);
                    continue;
                };
                let words = match transcribe_chunk(&w, &pcm16, chunk.start_us, first, &|| !alive()) {
                    Ok(words) => words,
                    Err(e) => {
                        dlog!("chunk at {} us: {e}", chunk.start_us);
                        continue;
                    }
                };
                dlog!("chunk at {} us: {} words", chunk.start_us, words.len());
                let before = kept.len();
                append_words(&mut kept, words);
                let new: Vec<LiveWordDto> =
                    kept[before..].iter().map(|w| LiveWordDto { text: w.text.clone(), start_us: w.start_us, end_us: w.end_us }).collect();
                // Only the last words are needed for the overlap check.
                if kept.len() > 64 {
                    kept.drain(..kept.len() - 16);
                }
                if !new.is_empty() {
                    let _ = app.emit_to(OVERLAY, WORDS_EVENT, WordsPayload { words: new });
                }
            }
        }
        dlog!("live end");
        let _ = std::fs::remove_dir_all(&work);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_trimmed_capped_and_numbered() {
        let raw: Vec<String> = ["  Pricing page ", "", "   ", "Refunds"].iter().map(|s| s.to_string()).collect();
        let t = topics(&raw);
        assert_eq!(t, vec![ChecklistTopic { id: "c1".into(), text: "Pricing page".into() }, ChecklistTopic { id: "c2".into(), text: "Refunds".into() }]);
        let many: Vec<String> = (0..20).map(|i| format!("T{i}")).collect();
        assert_eq!(topics(&many).len(), MAX_TOPICS);
        assert_eq!(topics(&["é".repeat(200)])[0].text.chars().count(), MAX_TEXT);
    }

    #[test]
    fn tick_rules() {
        let mut items = items_of(&topics(&["A".into(), "B".into(), "C".into()]));
        assert_eq!(tick(&mut items, Some("c2"), Some(5_000_000), "auto", 9_000_000), Some(("c2".into(), 5_000_000)));
        assert_eq!(tick(&mut items, Some("c2"), Some(6_000_000), "ai", 9_000_000), None, "already ticked");
        assert_eq!(tick(&mut items, None, None, "hand", 9_500_000), Some(("c1".into(), 9_500_000)), "next open one, now");
        assert_eq!(tick(&mut items, Some("c3"), Some(99_000_000), "auto", 10_000_000), Some(("c3".into(), 10_000_000)), "never after now");
        assert_eq!(tick(&mut items, None, None, "hand", 11_000_000), None, "all ticked");
        let mut more = items_of(&topics(&["A".into()]));
        assert_eq!(tick(&mut more, Some("c9"), None, "auto", 1), None);
        assert_eq!(tick(&mut more, Some("c1"), Some(-5), "magic", 1), None);
        assert_eq!(tick(&mut more, Some("c1"), Some(-5), "auto", 1), Some(("c1".into(), 0)));
        assert_eq!(items_of(&topics(&["A".into()]))[0].by, None);
        assert_eq!(more[0].by.as_deref(), Some("auto"));
    }
}
