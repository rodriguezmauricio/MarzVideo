//! Transcription for the AI pass: whisper.cpp (CLI sidecar) per section of `mic.wav`, written to
//! `transcript.json` in the project folder. The raw `mic.wav` is only read; Whisper gets a 16 kHz
//! copy in a temp folder.

pub mod models;
pub mod run;
pub mod sections;
pub mod transcript;
pub mod whisper;

pub use models::{ModelStatus, model_dir, model_status};
pub use run::{TranscribeError, plan_sections, run_transcription};
pub use sections::split_sections;
pub use transcript::{MicStamp, Section, Transcript, Word, mic_stamp, transcript_is_current, write_transcript};
pub use whisper::{FILLER_PROMPT, find_whisper, parse_whisper_json, whisper_args};
