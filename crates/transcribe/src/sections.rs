//! Splitting the mic audio into sections at pauses, and the small WAV reader and writer the
//! transcription needs. Whisper runs once per section so each section gets its own language,
//! and sections must be separate files because `-ot`/`-d` are ignored when VAD is on.

use std::fs;
use std::io;
use std::path::Path;

/// A quiet run must last this long to be a cut point.
pub const DEFAULT_MIN_PAUSE_US: i64 = 1_000_000;
/// Sections are at least this long, except the last one.
pub const DEFAULT_MIN_LEN_US: i64 = 30_000_000;
/// Sections are never longer than this.
pub const DEFAULT_MAX_LEN_US: i64 = 120_000_000;
/// Level step used to plan sections (10 ms, like `micLevels` in `@marz/autoedit`).
pub const LEVEL_STEP_US: i64 = 10_000;

/// When no pause is found, the forced cut is searched in this window before the max length.
const FORCED_CUT_WINDOW_US: i64 = 10_000_000;

/// The level under which a step counts as quiet: 20th percentile times 2, never under 0.002.
pub fn quiet_floor(levels: &[f32]) -> f32 {
    if levels.is_empty() {
        return 0.002;
    }
    let mut sorted: Vec<f32> = levels.iter().copied().filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return 0.002;
    }
    sorted.sort_by(|a, b| a.total_cmp(b));
    let idx = ((sorted.len() - 1) as f64 * 0.2).floor() as usize;
    (sorted[idx] * 2.0).max(0.002)
}

/// Splits audio described by per-step `levels` into sections `(start_us, end_us)`.
///
/// The sections cover the whole audio in order with no gaps. Cut points sit in the middle of quiet
/// runs (level under [`quiet_floor`]) of at least `min_pause_us`. A section is at least
/// `min_len_us` long (except the last) and never longer than `max_len_us`; with no pause in reach,
/// it is cut at the quietest step shortly before the max length.
pub fn split_sections(levels: &[f32], step_us: i64, min_pause_us: i64, min_len_us: i64, max_len_us: i64) -> Vec<(i64, i64)> {
    if levels.is_empty() || step_us <= 0 {
        return Vec::new();
    }
    let total = levels.len();
    let steps = |us: i64| -> usize { (us.max(0) / step_us) as usize };
    let min_pause = steps(min_pause_us).max(1);
    let min_len = steps(min_len_us);
    let max_len = steps(max_len_us).max(1).max(min_len);
    let floor = quiet_floor(levels);

    // Candidate cut points: the middle of each long enough quiet run.
    let mut cuts: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < total {
        if levels[i] < floor {
            let start = i;
            while i < total && levels[i] < floor {
                i += 1;
            }
            if i - start >= min_pause {
                cuts.push((start + i) / 2);
            }
        } else {
            i += 1;
        }
    }

    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    loop {
        let rest = total - start;
        let fits = rest <= max_len;
        // The first pause past the min length, within the max length, that does not leave a
        // too-short last section when the rest would fit anyway.
        let pick = cuts.iter().copied().find(|&c| {
            c > start && c < total && c - start >= min_len && c - start <= max_len && !(fits && total - c < min_len)
        });
        let cut = match pick {
            Some(c) => c,
            None if fits => {
                out.push((start, total));
                break;
            }
            None => {
                let hi = start + max_len;
                let window = steps(FORCED_CUT_WINDOW_US).max(1);
                let lo = (start + min_len.max(1)).max(hi.saturating_sub(window)).min(hi);
                let mut best = hi;
                for s in lo..=hi {
                    if levels[s] < levels[best] {
                        best = s;
                    }
                }
                best.max(start + 1)
            }
        };
        out.push((start, cut));
        start = cut;
    }
    out.into_iter().map(|(a, b)| (a as i64 * step_us, b as i64 * step_us)).collect()
}

/// RMS level (0..1) of each `step_us` slice of 16-bit PCM at `rate` Hz. The last partial slice counts.
pub fn wav_levels(pcm: &[i16], rate: u32, step_us: i64) -> Vec<f32> {
    let per = ((rate as i64 * step_us) / 1_000_000).max(1) as usize;
    pcm.chunks(per)
        .map(|c| {
            let sum: f64 = c.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
            (sum / c.len() as f64).sqrt() as f32
        })
        .collect()
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

/// Reads a 16-bit PCM mono WAV. Tolerates extra chunks and a data length that is 0 or larger than
/// the file (as written by a recorder that did not finish its header): the rest of the file is the data.
pub fn read_wav_mono16(path: &Path) -> io::Result<(u32, Vec<i16>)> {
    let bytes = fs::read(path)?;
    parse_wav_mono16(&bytes)
}

fn parse_wav_mono16(bytes: &[u8]) -> io::Result<(u32, Vec<i16>)> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad("not a WAV file"));
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let mut rate: Option<u32> = None;
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32_at(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            if body + 16 > bytes.len() {
                return Err(bad("short fmt chunk"));
            }
            let format = u16_at(body);
            let channels = u16_at(body + 2);
            let bits = u16_at(body + 14);
            // 1 = PCM, 0xFFFE = extensible (accepted when it is 16-bit mono).
            if (format != 1 && format != 0xFFFE) || channels != 1 || bits != 16 {
                return Err(bad("WAV is not 16-bit PCM mono"));
            }
            rate = Some(u32_at(body + 4));
        } else if id == b"data" {
            let rate = rate.ok_or_else(|| bad("data chunk before fmt chunk"))?;
            let avail = bytes.len() - body;
            let n = if len == 0 || len > avail { avail } else { len };
            let pcm = bytes[body..body + (n & !1)].as_chunks::<2>().0.iter().map(|c| i16::from_le_bytes(*c)).collect();
            return Ok((rate, pcm));
        }
        // Chunks are padded to an even length.
        pos = body.saturating_add(len).saturating_add(len & 1);
    }
    Err(bad("WAV has no data chunk"))
}

/// Writes `pcm` as a 16-bit PCM mono WAV at `rate` Hz.
pub fn write_wav_mono16(path: &Path, rate: u32, pcm: &[i16]) -> io::Result<()> {
    let data_len = (pcm.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + pcm.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    fs::write(path, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEP: i64 = 10_000;
    const LOUD: f32 = 0.2;
    const QUIET: f32 = 0.0001;

    /// Levels for `secs` seconds of speech (350 ms of voice, 150 ms gap between words, like a
    /// noise-gated mic) with long quiet runs `(at_s, len_s)`.
    fn levels(secs: f64, pauses: &[(f64, f64)]) -> Vec<f32> {
        let n = (secs * 100.0) as usize;
        let mut v: Vec<f32> = (0..n).map(|i| if i % 50 < 35 { LOUD } else { QUIET }).collect();
        for &(at, len) in pauses {
            let a = (at * 100.0) as usize;
            let b = (((at + len) * 100.0) as usize).min(n);
            for x in &mut v[a..b] {
                *x = QUIET;
            }
        }
        v
    }

    /// True when `us` lies inside one of the pauses.
    fn in_pause(us: i64, pauses: &[(f64, f64)]) -> bool {
        pauses.iter().any(|&(at, len)| us as f64 >= at * 1e6 && us as f64 <= (at + len) * 1e6)
    }

    fn split(v: &[f32]) -> Vec<(i64, i64)> {
        split_sections(v, STEP, DEFAULT_MIN_PAUSE_US, DEFAULT_MIN_LEN_US, DEFAULT_MAX_LEN_US)
    }

    fn assert_covers(s: &[(i64, i64)], total_us: i64) {
        assert!(!s.is_empty());
        assert_eq!(s[0].0, 0);
        assert_eq!(s.last().unwrap().1, total_us);
        for w in s.windows(2) {
            assert_eq!(w[0].1, w[1].0, "gap or overlap between sections");
        }
        for &(a, b) in s {
            assert!(b > a, "empty section");
        }
    }

    #[test]
    fn splits_at_pauses_over_1_s() {
        // Pauses at 40 s (1.5 s), 50 s (0.8 s, too short), 85 s (1.2 s). 150 s total.
        let pauses = [(40.0, 1.5), (85.0, 1.2)];
        let v = levels(150.0, &[(40.0, 1.5), (50.0, 0.8), (85.0, 1.2)]);
        let s = split(&v);
        assert_covers(&s, 150_000_000);
        assert_eq!(s.len(), 3, "{s:?}");
        assert!(in_pause(s[0].1, &pauses[..1]), "first cut in the 40 s pause: {s:?}");
        assert!(in_pause(s[1].1, &pauses[1..]), "second cut in the 85 s pause: {s:?}");
    }

    #[test]
    fn respects_min_length_and_avoids_a_short_tail() {
        // Pauses at 10 s (too early), 100 s, and 140 s (would leave a 5 s tail while the rest fits).
        let v = levels(145.0, &[(10.0, 2.0), (100.0, 2.0), (140.0, 2.0)]);
        let s = split(&v);
        assert_covers(&s, 145_000_000);
        assert_eq!(s.len(), 2, "{s:?}");
        assert!(in_pause(s[0].1, &[(100.0, 2.0)]), "{s:?}");
    }

    #[test]
    fn never_makes_a_section_over_max_length() {
        // Five minutes of steady sound with no pause at all, and a slightly quieter step at 115 s.
        let mut v = vec![LOUD; 30_000];
        v[11_500] = 0.1;
        let s = split(&v);
        assert_covers(&s, 300_000_000);
        for &(a, b) in &s {
            assert!(b - a <= DEFAULT_MAX_LEN_US, "section {a}..{b} is too long");
        }
        assert_eq!(s[0], (0, 115_000_000), "forced cut at the quietest step near the max");
    }

    #[test]
    fn sections_cover_the_audio_without_gaps() {
        let pauses = [(3.0, 1.0), (33.0, 1.1), (61.0, 3.0), (200.0, 1.0), (260.0, 5.0), (400.0, 1.4), (601.0, 2.0)];
        let v = levels(617.3, &pauses);
        let s = split(&v);
        assert_covers(&s, v.len() as i64 * STEP);
        for (i, &(a, b)) in s.iter().enumerate() {
            assert!(b - a <= DEFAULT_MAX_LEN_US);
            if i + 1 < s.len() {
                assert!(b - a >= DEFAULT_MIN_LEN_US, "{s:?}");
            }
        }
        // Short audio is one section; no audio is none.
        assert_eq!(split(&levels(12.0, &[(5.0, 2.0)])), vec![(0, 12_000_000)]);
        assert!(split(&[]).is_empty());
    }

    #[test]
    fn floor_follows_the_noise_gated_mic() {
        let v = levels(100.0, &[]);
        assert_eq!(quiet_floor(&v), 0.002);
        let noisy = vec![0.01f32; 100];
        assert!((quiet_floor(&noisy) - 0.02).abs() < 1e-6);
    }

    #[test]
    fn wav_round_trip() {
        let dir = std::env::temp_dir().join(format!("marz-transcribe-wav-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.wav");
        let pcm: Vec<i16> = (0..16_000).map(|i| ((i as f32 * 0.05).sin() * 12_000.0) as i16).collect();
        write_wav_mono16(&path, 16_000, &pcm).unwrap();
        let (rate, back) = read_wav_mono16(&path).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(back, pcm);

        // Extra chunk before data and a 0 data length: still reads everything.
        let mut bytes = fs::read(&path).unwrap();
        let mut odd = bytes[..36].to_vec();
        odd.extend_from_slice(b"LIST");
        odd.extend_from_slice(&3u32.to_le_bytes());
        odd.extend_from_slice(b"abc\0"); // 3 bytes plus pad
        odd.extend_from_slice(b"data");
        odd.extend_from_slice(&0u32.to_le_bytes());
        odd.extend_from_slice(&bytes[44..]);
        assert_eq!(parse_wav_mono16(&odd).unwrap().1, pcm);

        // A data length larger than the file: the rest of the file.
        bytes[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(parse_wav_mono16(&bytes).unwrap().1, pcm);

        // Levels: 100 steps of 10 ms for one second at 16 kHz, all loud.
        let lv = wav_levels(&pcm, 16_000, STEP);
        assert_eq!(lv.len(), 100);
        assert!(lv.iter().all(|&l| l > 0.1));

        // Stereo is refused.
        let mut stereo = fs::read(&path).unwrap();
        stereo[22] = 2;
        assert!(parse_wav_mono16(&stereo).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
