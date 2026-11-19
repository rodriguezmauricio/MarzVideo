//! Export muxer. The webview composites and encodes the video (H.264 annexb); this crate runs FFmpeg
//! to copy that stream, add the mic audio with the cuts and offset applied, and write the MP4.

pub mod args;
pub mod clean;
pub mod loudness;
pub mod process;
pub mod tools;
pub mod wav;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use args::{audio_filter, audio_filter_with, ffmpeg_args};
pub use process::{CancelHandle, ExportProcess, ExportReport};

/// One kept source range. Same fields as `Segment` in `packages/timeline/src/segments.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub src_start_us: i64,
    pub src_end_us: i64,
    pub out_start_us: i64,
}

/// The mic track of a project. `offset_us` is where mic sample 0 sits on the project's source clock
/// (the clock of `segments`, the same clock as the screen track's own `offsetUs`): mic time = source
/// time - `offset_us`. It is not relative to the screen track's first frame; the editor's preview
/// plays the mic the same way (`audio.currentTime = (srcUs - mic.offsetUs) / 1e6`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicJob {
    /// File name inside the project folder (`mic.wav`).
    pub file: String,
    pub offset_us: i64,
    pub volume: f64,
    pub muted: bool,
    /// Fade in from the start of the export, in output time (0: none).
    #[serde(default)]
    pub fade_in_us: i64,
    /// Fade out to the end of the export, in output time (0: none).
    #[serde(default)]
    pub fade_out_us: i64,
    /// Read the noise-cleaned copy `cache/mic.clean.wav` (same length as `file`) instead of `file`.
    /// The path is fixed here, never sent by the page. Only meant for the mic.
    #[serde(default)]
    pub clean: bool,
}

/// Bring the exported mix to `target_lufs` (integrated), true peak at most -1.5 dBTP.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Normalize {
    pub target_lufs: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub project_dir: PathBuf,
    pub out_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub segments: Vec<Segment>,
    pub mic: Option<MicJob>,
    /// The computer's sound (`system.wav`), mixed with the mic. Same shape as the mic.
    #[serde(default)]
    pub system: Option<MicJob>,
    pub output_duration_us: i64,
    /// Loudness normalization of the mix (absent: none).
    #[serde(default)]
    pub normalize: Option<Normalize>,
}
