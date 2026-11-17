//! Export muxer. The webview composites and encodes the video (H.264 annexb); this crate runs FFmpeg
//! to copy that stream, add the mic audio with the cuts and offset applied, and write the MP4.

pub mod args;
pub mod process;
pub mod tools;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use args::{audio_filter, ffmpeg_args};
pub use process::{ExportProcess, ExportReport};

/// One kept source range. Same fields as `Segment` in `packages/timeline/src/segments.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub src_start_us: i64,
    pub src_end_us: i64,
    pub out_start_us: i64,
}

/// The mic track of a project. `offset_us` is how long after the screen track started the mic started.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicJob {
    /// File name inside the project folder (`mic.wav`).
    pub file: String,
    pub offset_us: i64,
    pub volume: f64,
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub project_dir: PathBuf,
    pub out_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub segments: Vec<Segment>,
    pub mic: Option<MicJob>,
    pub output_duration_us: i64,
}
