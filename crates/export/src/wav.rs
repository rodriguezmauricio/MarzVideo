//! Length of a PCM WAV file from its header, so the filter builder knows where the mic ends
//! without running ffprobe.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Duration in microseconds of the audio in a RIFF/WAVE file, from the `fmt ` and `data` chunks.
/// A `data` size that is 0, 0xFFFFFFFF (streaming writers) or bigger than the file is replaced by
/// what is actually in the file. None when the file is not a readable PCM WAV.
pub fn wav_duration_us(path: &Path) -> Option<i64> {
    let mut f = File::open(path).ok()?;
    let file_len = f.metadata().ok()?.len();
    let mut riff = [0u8; 12];
    f.read_exact(&mut riff).ok()?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12u64;
    let mut rate_and_frame: Option<(u64, u64)> = None;
    loop {
        let mut head = [0u8; 8];
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut head).ok()?;
        let size = u32::from_le_bytes(head[4..8].try_into().ok()?) as u64;
        let body = pos + 8;
        match &head[0..4] {
            b"fmt " => {
                let mut fmt = [0u8; 16];
                f.read_exact(&mut fmt).ok()?;
                let rate = u32::from_le_bytes(fmt[4..8].try_into().ok()?) as u64;
                let frame = u16::from_le_bytes(fmt[12..14].try_into().ok()?) as u64;
                rate_and_frame = Some((rate, frame));
            }
            b"data" => {
                let (rate, frame) = rate_and_frame?;
                if rate == 0 || frame == 0 {
                    return None;
                }
                let in_file = file_len.saturating_sub(body);
                let bytes = if size == 0 || size > in_file { in_file } else { size };
                return Some((bytes / frame * 1_000_000 / rate) as i64);
            }
            _ => {}
        }
        // Chunks are padded to an even size.
        pos = body + size + (size & 1);
        if pos >= file_len {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn wav_bytes(rate: u32, channels: u16, data: &[u8], declared: Option<u32>, extra_chunk: bool) -> Vec<u8> {
        let frame = channels * 2;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * frame as u32).to_le_bytes());
        b.extend_from_slice(&frame.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        if extra_chunk {
            b.extend_from_slice(b"LIST");
            b.extend_from_slice(&3u32.to_le_bytes());
            b.extend_from_slice(&[1, 2, 3, 0]);
        }
        b.extend_from_slice(b"data");
        b.extend_from_slice(&declared.unwrap_or(data.len() as u32).to_le_bytes());
        b.extend_from_slice(data);
        b
    }

    fn write(tag: &str, bytes: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!("marz-wav-{tag}-{}.wav", std::process::id()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn reads_the_declared_length() {
        // 1 s of 48 kHz mono 16-bit.
        let p = write("plain", &wav_bytes(48_000, 1, &vec![0u8; 96_000], None, false));
        assert_eq!(wav_duration_us(&p), Some(1_000_000));
    }

    #[test]
    fn skips_other_chunks_and_counts_channels() {
        // 0.5 s of 44.1 kHz stereo, with an odd-sized LIST chunk before the data.
        let p = write("list", &wav_bytes(44_100, 2, &vec![0u8; 44_100 * 4 / 2], None, true));
        assert_eq!(wav_duration_us(&p), Some(500_000));
    }

    #[test]
    fn streaming_or_wrong_data_sizes_fall_back_to_the_file() {
        let data = vec![0u8; 48_000]; // 0.5 s mono
        for declared in [0u32, 0xFFFF_FFFF, 10_000_000] {
            let p = write("stream", &wav_bytes(48_000, 1, &data, Some(declared), false));
            assert_eq!(wav_duration_us(&p), Some(500_000), "declared {declared}");
        }
    }

    #[test]
    fn not_a_wav_is_none() {
        assert_eq!(wav_duration_us(&write("junk", b"hello world, not a wav file at all")), None);
        assert_eq!(wav_duration_us(Path::new("definitely-missing.wav")), None);
    }
}
