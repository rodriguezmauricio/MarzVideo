//! Marz capture engine: screen, mic and input capture written into a `.marz` project.
//! Windows-only code lives in `win`; everything else is cross-platform.

pub mod clock;
pub mod events;
pub mod ffmpeg;
pub mod hotkeys;
pub mod keys;
pub mod mic_timeline;
pub mod project;
pub mod recover;
pub mod region;
pub mod slots;
pub mod writer;
#[cfg(windows)]
pub mod win;

use std::fmt;

#[derive(Debug)]
pub enum CaptureError {
    NoFfmpeg,
    Device(String),
    Io(std::io::Error),
    Encoder(String),
    Busy,
    /// A sentence for the person recording, shown as is (e.g. "Region is too small. Drag at least 64 x 64.").
    User(String),
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CaptureError::NoFfmpeg => write!(f, "ffmpeg was not found"),
            CaptureError::Device(msg) => write!(f, "capture device error: {msg}"),
            CaptureError::Io(err) => write!(f, "io error: {err}"),
            CaptureError::Encoder(msg) => write!(f, "encoder error: {msg}"),
            CaptureError::Busy => write!(f, "a recording is already running"),
            CaptureError::User(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for CaptureError {}

impl From<std::io::Error> for CaptureError {
    fn from(err: std::io::Error) -> Self {
        CaptureError::Io(err)
    }
}
