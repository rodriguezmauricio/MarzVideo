//! Marz capture engine: screen, mic and input capture written into a `.marz` project.
//! Windows-only code lives in `win`; everything else is cross-platform.

pub mod clock;
pub mod events;
pub mod ffmpeg;
pub mod mic_timeline;
pub mod project;
pub mod recover;
pub mod slots;
#[cfg(windows)]
pub mod win;

use std::fmt;

// Dependencies are declared now and used by later tasks; silence the unused-dependency lint until then.
#[cfg(windows)]
use {wasapi as _, windows as _, windows_capture as _};

#[derive(Debug)]
pub enum CaptureError {
    NoFfmpeg,
    Device(String),
    Io(std::io::Error),
    Encoder(String),
    Busy,
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CaptureError::NoFfmpeg => write!(f, "ffmpeg was not found"),
            CaptureError::Device(msg) => write!(f, "capture device error: {msg}"),
            CaptureError::Io(err) => write!(f, "io error: {err}"),
            CaptureError::Encoder(msg) => write!(f, "encoder error: {msg}"),
            CaptureError::Busy => write!(f, "a recording is already running"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl From<std::io::Error> for CaptureError {
    fn from(err: std::io::Error) -> Self {
        CaptureError::Io(err)
    }
}
