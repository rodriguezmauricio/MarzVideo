//! Loudness normalization at export, in two steps: measure the export's audio mix with `ebur128`,
//! then end the mux graph in `loudnorm` fed the measured values.

use crate::ExportJob;
use crate::args::{audio_filter, used_inputs};
use crate::tools::command;
use std::path::Path;
use std::process::Stdio;

/// True peak ceiling of the export, dBTP.
pub const TRUE_PEAK_DB: f64 = -1.5;
/// Loudness range `loudnorm` aims for in its dynamic mode, LU.
pub const LRA_LU: f64 = 11.0;
/// A mix quieter than this (LUFS) is silence or near it: leave it alone.
pub const SILENT_LUFS: f64 = -70.0;

/// What `ebur128` measured over the whole mix.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub i: f64,
    /// Gating threshold of the integrated loudness, LUFS.
    pub thresh: f64,
    /// Loudness range, LU.
    pub lra: f64,
    /// True peak, dBFS.
    pub tp: f64,
}

/// Reads the `Summary:` block `ebur128=peak=true` prints at the end of its stderr. None when it is
/// missing or the integrated loudness is not a number (`-inf` for silence).
pub fn parse_ebur128(stderr: &str) -> Option<Loudness> {
    let summary = &stderr[stderr.rfind("Summary:")?..];
    // The first number after `label` on a line that starts with it (after spaces).
    let value = |section: &str, label: &str| -> Option<f64> {
        let from = summary.find(section)?;
        summary[from..].lines().find_map(|l| l.trim_start().strip_prefix(label).and_then(|rest| rest.split_whitespace().next()?.parse::<f64>().ok()))
    };
    let l = Loudness {
        i: value("Integrated loudness:", "I:")?,
        thresh: value("Integrated loudness:", "Threshold:")?,
        lra: value("Loudness range:", "LRA:")?,
        tp: value("True peak:", "Peak:")?,
    };
    (l.i.is_finite() && l.thresh.is_finite() && l.lra.is_finite() && l.tp.is_finite()).then_some(l)
}

/// The tail that brings the mix to `target` LUFS: `loudnorm` in linear mode with the measured values
/// (it falls back to its dynamic mode by itself when a plain gain would push peaks over the ceiling),
/// then back to 48 kHz (loudnorm works at 192 kHz).
pub fn loudnorm_filter(target: f64, m: &Loudness) -> String {
    format!(
        "loudnorm=I={target}:TP={TRUE_PEAK_DB}:LRA={LRA_LU}:measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset=0:linear=true,aresample=48000",
        m.i, m.tp, m.lra, m.thresh
    )
}

/// Whether a measured mix should be normalized (not silence).
pub fn worth_normalizing(m: &Loudness) -> bool {
    m.i > SILENT_LUFS
}

/// FFmpeg arguments that run the export's audio graph into `ebur128` and discard the result. None
/// when the export has no audio graph (silent track).
pub fn measure_args(job: &ExportJob) -> Option<Vec<String>> {
    let graph = audio_filter(job)?;
    // Input 0 stands in for the video stream so the graph's audio inputs keep their numbers (1, 2).
    let mut a: Vec<String> =
        ["-hide_banner", "-nostats", "-loglevel", "info", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.01"].iter().map(|s| s.to_string()).collect();
    for path in used_inputs(job) {
        a.push("-i".into());
        a.push(path.to_string_lossy().into_owned());
    }
    a.push("-filter_complex".into());
    a.push(format!("{graph};[aout]ebur128=peak=true:framelog=quiet[m]"));
    a.extend(["-map", "[m]", "-f", "null", "-"].iter().map(|s| s.to_string()));
    Some(a)
}

/// Measure the export's mix. Ok(None) when there is nothing to measure (no audio graph) or the mix
/// is silent; Err when FFmpeg fails.
pub fn measure(ffmpeg: &Path, job: &ExportJob) -> Result<Option<Loudness>, String> {
    let Some(args) = measure_args(job) else { return Ok(None) };
    let out = command(ffmpeg).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).output().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let err = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let tail: Vec<&str> = err.lines().rev().take(8).collect();
        return Err(format!("loudness measure failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join("\n")));
    }
    Ok(parse_ebur128(&err).filter(worth_normalizing))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMMARY: &str = "[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -21.8 LUFS
    Threshold: -32.4 LUFS

  Loudness range:
    LRA:         9.6 LU
    Threshold: -42.9 LUFS
    LRA low:   -29.0 LUFS
    LRA high:  -19.4 LUFS

  True peak:
    Peak:       -1.7 dBFS
[out#0/null @ 0x2] video:0KiB audio:44812KiB";

    #[test]
    fn parses_the_summary() {
        let l = parse_ebur128(&format!("t: 1.0 M: -30 S: -30 I: -99 LUFS\n{SUMMARY}")).unwrap();
        assert_eq!(l, Loudness { i: -21.8, thresh: -32.4, lra: 9.6, tp: -1.7 });
    }

    #[test]
    fn silence_and_garbage_give_none() {
        assert_eq!(parse_ebur128("no summary here"), None);
        let silent = SUMMARY.replace("-21.8 LUFS", "-inf LUFS").replace("-32.4 LUFS", "-inf LUFS");
        assert_eq!(parse_ebur128(&silent), None);
        assert!(!worth_normalizing(&Loudness { i: -75.0, thresh: -85.0, lra: 0.0, tp: -60.0 }));
        assert!(worth_normalizing(&Loudness { i: -21.8, thresh: -32.4, lra: 9.6, tp: -1.7 }));
    }

    #[test]
    fn loudnorm_gets_the_measured_values() {
        let f = loudnorm_filter(-14.0, &Loudness { i: -21.8, thresh: -32.4, lra: 9.6, tp: -1.7 });
        assert_eq!(
            f,
            "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-21.80:measured_TP=-1.70:measured_LRA=9.60:measured_thresh=-32.40:offset=0:linear=true,aresample=48000"
        );
    }
}
