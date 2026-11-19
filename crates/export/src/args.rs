//! FFmpeg argument and audio filter builders.

use crate::loudness::{Loudness, loudnorm_filter};
use crate::{ExportJob, MicJob, VideoCodec};
use std::path::{Path, PathBuf};

/// Microseconds as seconds with 6 decimals (negative values clamp to 0).
fn secs(us: i64) -> String {
    let us = us.max(0);
    format!("{}.{:06}", us / 1_000_000, us % 1_000_000)
}

/// Microseconds as milliseconds with 3 decimals, for `adelay`.
fn millis(us: i64) -> String {
    let us = us.max(0);
    format!("{}.{:03}", us / 1_000, us % 1_000)
}

/// The audio tracks that are used (present and not muted), mic first: (track, file path). A track
/// marked `clean` reads the noise-cleaned copy.
fn used_tracks(job: &ExportJob) -> Vec<(&MicJob, PathBuf)> {
    [job.mic.as_ref(), job.system.as_ref()]
        .into_iter()
        .flatten()
        .filter(|t| !t.muted)
        .map(|t| (t, if t.clean { crate::clean::clean_path(&job.project_dir) } else { job.project_dir.join(&t.file) }))
        .collect()
}

/// The audio files FFmpeg reads, in input order (inputs 1, 2 of the mux).
pub fn used_inputs(job: &ExportJob) -> Vec<PathBuf> {
    used_tracks(job).into_iter().map(|(_, p)| p).collect()
}

/// Overlap with the mic shorter than this (1 ms, 48 samples) counts as no overlap: `atrim` of such a
/// sliver can come out empty, and `apad` on an empty stream never ends.
const MIN_OVERLAP_US: i64 = 1_000;

/// `audio_filter` with each used track's length read from its WAV header. If a header cannot be
/// read that length is unknown and the track is assumed long enough.
pub fn audio_filter(job: &ExportJob) -> Option<String> {
    audio_filter_loud(job, None)
}

/// `audio_filter` ending in the loudness tail for the measured mix `loud` (None: no tail).
pub fn audio_filter_loud(job: &ExportJob, loud: Option<&Loudness>) -> Option<String> {
    let lens: Vec<Option<i64>> = used_tracks(job).iter().map(|(_, p)| crate::wav::wav_duration_us(p)).collect();
    let tail = match (&job.normalize, loud) {
        (Some(n), Some(m)) => Some(loudnorm_filter(n.target_lufs, m)),
        _ => None,
    };
    audio_graph(job, &lens, tail.as_deref())
}

/// `audio_filter` with the mic's length given (tests); a used system track's length is read from
/// its header.
pub fn audio_filter_with(job: &ExportJob, mic_len_us: Option<i64>) -> Option<String> {
    let lens: Vec<Option<i64>> = used_tracks(job)
        .iter()
        .map(|(t, p)| if job.mic.as_ref().is_some_and(|m| std::ptr::eq(m, *t)) { mic_len_us } else { crate::wav::wav_duration_us(p) })
        .collect();
    audio_graph(job, &lens, None)
}

/// The `-filter_complex` graph that cuts each used audio track to the kept segments and mixes them,
/// ending in the `[aout]` pad. Used tracks are inputs 1, 2 (mic first) with lengths `lens` (None:
/// unknown). `tail` (the loudness step) goes last, before `[aout]`. None when no track is used or
/// there are no segments: the caller writes a silent track.
fn audio_graph(job: &ExportJob, lens: &[Option<i64>], tail: Option<&str>) -> Option<String> {
    let tracks = used_tracks(job);
    let segs: Vec<_> = job.segments.iter().filter(|s| s.src_end_us > s.src_start_us).collect();
    if tracks.is_empty() || segs.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for (k, (t, _)) in tracks.iter().enumerate() {
        track_chain(&mut parts, &segs, t, k, lens.get(k).copied().flatten(), job.output_duration_us);
    }
    let end = secs(job.output_duration_us);
    let tail = tail.map(|t| format!(",{t}")).unwrap_or_default();
    if tracks.len() == 1 {
        parts.push(format!("[t0]apad,atrim=end={end}{tail}[aout]"));
    } else {
        // Plain sum (no level drop): each track keeps the level it had alone.
        let ins: String = (0..tracks.len()).map(|k| format!("[t{k}]")).collect();
        parts.push(format!("{ins}amix=inputs={}:duration=longest:normalize=0,apad,atrim=end={end}{tail}[aout]", tracks.len()));
    }
    Some(parts.join(";"))
}

/// The chain for one track (input `k + 1`) ending in `[t{k}]`.
///
/// Each segment is mapped to the track's timeline by subtracting its `offset_us`.
/// - It overlaps the track: `atrim` of the overlap, `adelay` for the part before the track starts, and
///   `apad` to the exact segment length for the part after the track ends. The input of `apad` is
///   never empty, so it ends.
/// - It lies wholly before the track starts or wholly after it ends: a generated silence of exactly
///   the segment length. (An `atrim` that returns nothing would hang `apad` or break timestamps.)
/// The track's volume and fades (in output time, `dur_us` long) follow the concat.
fn track_chain(parts: &mut Vec<String>, segs: &[&crate::Segment], t: &MicJob, k: usize, len_us: Option<i64>, dur_us: i64) {
    let input = k + 1;
    // Labels: the first track keeps the plain names (s0, a0), later ones get a track prefix.
    let pre = if k == 0 { String::new() } else { format!("k{k}") };
    let offset = t.offset_us;
    let track_len = len_us.unwrap_or(i64::MAX);
    let overlap = |s: &crate::Segment| (s.src_end_us - offset).min(track_len) - (s.src_start_us - offset).max(0);
    let readers = segs.iter().filter(|s| overlap(s) >= MIN_OVERLAP_US).count();
    // One format for every branch so `concat` accepts them: 48 kHz mono float.
    let norm = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono";
    match readers {
        0 => {}
        1 => parts.push(format!("[{input}:a]{norm}[{pre}s0]")),
        n => {
            let outs: String = (0..n).map(|i| format!("[{pre}s{i}]")).collect();
            parts.push(format!("[{input}:a]{norm},asplit={n}{outs}"));
        }
    }
    let mut reader = 0;
    let mut labels = String::new();
    for (i, s) in segs.iter().enumerate() {
        let len = s.src_end_us - s.src_start_us;
        let t_start = s.src_start_us - offset;
        let t_end = s.src_end_us - offset;
        if overlap(s) < MIN_OVERLAP_US {
            parts.push(format!("anullsrc=r=48000:cl=mono:d={0},aformat=sample_fmts=fltp,atrim=end={0}[{pre}a{i}]", secs(len)));
        } else {
            let mut chain = format!("[{pre}s{reader}]atrim=start={}:end={},asetpts=PTS-STARTPTS", secs(t_start), secs(t_end));
            if t_start < 0 {
                chain.push_str(&format!(",adelay={}:all=1", millis(-t_start)));
            }
            chain.push_str(&format!(",apad=whole_dur={}[{pre}a{i}]", secs(len)));
            parts.push(chain);
            reader += 1;
        }
        labels.push_str(&format!("[{pre}a{i}]"));
    }
    parts.push(format!("{labels}concat=n={}:v=0:a=1,volume={}{}[t{k}]", segs.len(), t.volume, fades(t, dur_us)));
}

/// `afade` filters for a track's fades (linear, like the preview), each at most the output length.
fn fades(t: &MicJob, dur_us: i64) -> String {
    let mut f = String::new();
    let fin = t.fade_in_us.clamp(0, dur_us);
    if fin > 0 {
        f.push_str(&format!(",afade=t=in:st=0:d={}", secs(fin)));
    }
    let fout = t.fade_out_us.clamp(0, dur_us);
    if fout > 0 {
        f.push_str(&format!(",afade=t=out:st={}:d={}", secs(dur_us - fout), secs(fout)));
    }
    f
}

/// The full FFmpeg command line (without the program). Video comes as H.264 annexb on stdin and is
/// copied; audio is the filtered mic and computer sound, or a silent track. Output is
/// `<out_path>.part` as MP4.
pub fn ffmpeg_args(job: &ExportJob) -> Vec<String> {
    ffmpeg_args_loud(job, None)
}

/// `ffmpeg_args` with the loudness tail for the measured mix `loud` (when the job asks for it).
pub fn ffmpeg_args_loud(job: &ExportJob, loud: Option<&Loudness>) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
    push(&["-hide_banner", "-loglevel", "warning", "-y"]);
    push(&["-f", job.codec.demuxer(), "-framerate", &job.fps.to_string(), "-i", "pipe:0"]);
    match audio_filter_loud(job, loud) {
        Some(graph) => {
            for (_, path) in used_tracks(job) {
                push(&["-i", &path.to_string_lossy()]);
            }
            push(&["-filter_complex", &graph, "-map", "0:v:0", "-map", "[aout]"]);
        }
        None => {
            push(&["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono"]);
            push(&["-map", "0:v:0", "-map", "1:a:0"]);
        }
    }
    push(&["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]);
    if job.codec == VideoCodec::Hevc {
        // `hvc1` (parameter sets in the sample entry) is what Windows and Apple players expect in an MP4.
        push(&["-tag:v", "hvc1"]);
    }
    // `-t` stops both tracks at the output length; the silent source and `apad` never end on their own.
    push(&["-t", &secs(job.output_duration_us)]);
    push(&["-movflags", "+faststart", "-f", "mp4", &part_path(&job.out_path).to_string_lossy()]);
    a
}

/// `<out_path>.part`: what FFmpeg writes until the export succeeds.
pub fn part_path(out: &Path) -> PathBuf {
    let mut s = out.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MicJob, Segment};
    use std::path::PathBuf;

    fn job(segments: Vec<Segment>, mic: Option<MicJob>, dur_us: i64) -> ExportJob {
        ExportJob {
            project_dir: PathBuf::from("proj"),
            out_path: PathBuf::from("out").join("video.mp4"),
            width: 1920,
            height: 1080,
            fps: 30,
            segments,
            mic,
            system: None,
            output_duration_us: dur_us,
            ..Default::default()
        }
    }

    fn seg(s: i64, e: i64, o: i64) -> Segment {
        Segment { src_start_us: s, src_end_us: e, out_start_us: o }
    }

    fn mic(offset_us: i64) -> MicJob {
        MicJob { file: "mic.wav".into(), offset_us, volume: 1.0, muted: false, ..Default::default() }
    }

    #[test]
    fn filter_trims_each_segment() {
        let j = job(vec![seg(1_000_000, 3_000_000, 0), seg(4_000_000, 5_500_000, 2_000_000)], Some(mic(0)), 3_500_000);
        let f = audio_filter(&j).unwrap();
        assert!(f.contains("atrim=start=1.000000:end=3.000000,asetpts=PTS-STARTPTS"), "{f}");
        assert!(f.contains("atrim=start=4.000000:end=5.500000,asetpts=PTS-STARTPTS"), "{f}");
        assert_eq!(f.matches("concat=n=2:v=0:a=1").count(), 1, "{f}");
        assert!(f.contains("volume=1"), "{f}");
        assert!(f.contains("apad"), "{f}");
        assert!(f.contains("atrim=end=3.500000"), "{f}");
        assert!(f.ends_with("[aout]"), "{f}");
    }

    #[test]
    fn filter_shifts_by_mic_offset() {
        let j = job(vec![seg(1_000_000, 2_000_000, 0)], Some(mic(12_400)), 1_000_000);
        let f = audio_filter(&j).unwrap();
        assert!(f.contains("atrim=start=0.987600:end=1.987600"), "{f}");
        assert!(!f.contains("adelay"), "{f}");
    }

    #[test]
    fn filter_pads_when_the_segment_starts_before_the_mic() {
        // Mic starts 0.5 s after the screen; the segment starts at 0.2 s, so 0.3 s of silence leads.
        let j = job(vec![seg(200_000, 1_200_000, 0)], Some(mic(500_000)), 1_000_000);
        let f = audio_filter(&j).unwrap();
        assert!(f.contains("atrim=start=0.000000:end=0.700000"), "{f}");
        assert!(f.contains("adelay=300.000:all=1"), "{f}");
    }

    #[test]
    fn filter_uses_silence_for_a_segment_wholly_before_the_mic() {
        let j = job(vec![seg(0, 400_000, 0), seg(600_000, 1_600_000, 400_000)], Some(mic(500_000)), 1_400_000);
        let f = audio_filter(&j).unwrap();
        assert!(f.contains("anullsrc=r=48000:cl=mono:d=0.400000"), "{f}");
        assert!(f.contains("atrim=start=0.100000:end=1.100000"), "{f}");
        assert!(f.contains("concat=n=2:v=0:a=1"), "{f}");
    }

    #[test]
    fn filter_uses_silence_for_a_segment_past_the_mic_end() {
        // 1 s mic: the second segment (1.2 s to 1.7 s) starts after it ended.
        let j = job(vec![seg(0, 1_000_000, 0), seg(1_200_000, 1_700_000, 1_000_000)], Some(mic(0)), 1_500_000);
        let f = audio_filter_with(&j, Some(1_000_000)).unwrap();
        assert!(f.contains("anullsrc=r=48000:cl=mono:d=0.500000"), "{f}");
        assert!(!f.contains("atrim=start=1.200000"), "{f}");
        assert!(!f.contains("asplit"), "only one segment reads the mic: {f}");
        assert!(f.contains("concat=n=2:v=0:a=1"), "{f}");
    }

    #[test]
    fn filter_pads_a_segment_straddling_the_mic_end() {
        let j = job(vec![seg(500_000, 1_500_000, 0)], Some(mic(0)), 1_000_000);
        let f = audio_filter_with(&j, Some(1_000_000)).unwrap();
        assert!(f.contains("atrim=start=0.500000:end=1.500000,asetpts=PTS-STARTPTS,apad=whole_dur=1.000000"), "{f}");
        assert!(!f.contains("anullsrc"), "{f}");
    }

    #[test]
    fn filter_treats_a_sliver_of_overlap_as_silence() {
        // Only 0.2 ms of mic left: an atrim that short can come out empty.
        let j = job(vec![seg(999_800, 1_999_800, 0)], Some(mic(0)), 1_000_000);
        let f = audio_filter_with(&j, Some(1_000_000)).unwrap();
        assert!(f.contains("anullsrc"), "{f}");
        assert!(!f.contains("[1:a]"), "{f}");
    }

    #[test]
    fn filter_reads_the_mic_length_from_the_wav_header() {
        let dir = std::env::temp_dir().join(format!("marz-args-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 44-byte header + 0.5 s of 48 kHz mono 16-bit.
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&[1, 0, 1, 0]);
        b.extend_from_slice(&48_000u32.to_le_bytes());
        b.extend_from_slice(&96_000u32.to_le_bytes());
        b.extend_from_slice(&[2, 0, 16, 0]);
        b.extend_from_slice(b"data");
        b.extend_from_slice(&48_000u32.to_le_bytes());
        b.extend_from_slice(&vec![0u8; 48_000]);
        std::fs::write(dir.join("mic.wav"), b).unwrap();
        let mut j = job(vec![seg(0, 500_000, 0), seg(600_000, 1_100_000, 500_000)], Some(mic(0)), 1_000_000);
        j.project_dir = dir;
        let f = audio_filter(&j).unwrap();
        assert!(f.contains("anullsrc=r=48000:cl=mono:d=0.500000"), "{f}");
    }

    #[test]
    fn filter_applies_volume() {
        let mut m = mic(0);
        m.volume = 0.5;
        let j = job(vec![seg(0, 1_000_000, 0)], Some(m), 1_000_000);
        assert!(audio_filter(&j).unwrap().contains("volume=0.5"));
    }

    #[test]
    fn muted_uses_silence() {
        let mut m = mic(0);
        m.muted = true;
        let j = job(vec![seg(0, 1_000_000, 0)], Some(m), 1_000_000);
        assert_eq!(audio_filter(&j), None);
        let args = ffmpeg_args(&j).join(" ");
        assert!(args.contains("-f lavfi -i anullsrc=r=48000:cl=mono"), "{args}");
        assert!(!args.contains("mic.wav"), "{args}");
    }

    #[test]
    fn no_mic_uses_silence() {
        let j = job(vec![seg(0, 1_000_000, 0)], None, 1_000_000);
        assert_eq!(audio_filter(&j), None);
        let args = ffmpeg_args(&j).join(" ");
        assert!(args.contains("-f lavfi -i anullsrc=r=48000:cl=mono"), "{args}");
        assert!(args.contains("-map 1:a:0"), "{args}");
    }

    #[test]
    fn hevc_is_read_as_hevc_and_tagged_hvc1() {
        let mut j = job(vec![seg(0, 1_000_000, 0)], Some(mic(0)), 1_000_000);
        j.codec = VideoCodec::Hevc;
        let s = ffmpeg_args(&j).join(" ");
        assert!(s.contains("-f hevc -framerate 30 -i pipe:0"), "{s}");
        assert!(s.contains("-c:v copy"), "{s}");
        assert!(s.contains("-tag:v hvc1"), "{s}");
    }

    #[test]
    fn codec_defaults_to_h264_when_the_page_does_not_send_it() {
        let j: ExportJob = serde_json::from_str(r#"{"projectDir":"p","outPath":"o.mp4","width":1920,"height":1080,"fps":30,"segments":[],"mic":null,"outputDurationUs":1}"#).unwrap();
        assert_eq!(j.codec, VideoCodec::H264);
        let h: ExportJob = serde_json::from_str(r#"{"projectDir":"p","outPath":"o.mp4","width":1920,"height":1080,"fps":30,"segments":[],"mic":null,"outputDurationUs":1,"codec":"hevc"}"#).unwrap();
        assert_eq!(h.codec, VideoCodec::Hevc);
        assert!(!ffmpeg_args(&j).join(" ").contains("hvc1"));
    }

    #[test]
    fn args_copy_video_and_encode_aac() {
        let j = job(vec![seg(0, 1_000_000, 0)], Some(mic(0)), 1_000_000);
        let args = ffmpeg_args(&j);
        let s = args.join(" ");
        assert!(s.contains("-f h264 -framerate 30 -i pipe:0"), "{s}");
        assert!(s.contains("-c:v copy"), "{s}");
        assert!(s.contains("-c:a aac -b:a 192k -ar 48000"), "{s}");
        assert!(s.contains("-movflags +faststart"), "{s}");
        assert!(s.contains("-t 1.000000"), "{s}");
        assert!(s.contains("-map 0:v:0 -map [aout]"), "{s}");
        assert!(!s.contains("-shortest"), "{s}");
        let mic_path = PathBuf::from("proj").join("mic.wav");
        assert!(args.contains(&mic_path.to_string_lossy().to_string()), "{s}");
        let n = args.len();
        assert_eq!(args[n - 3], "-f");
        assert_eq!(args[n - 2], "mp4");
        assert_eq!(args[n - 1], PathBuf::from("out").join("video.mp4.part").to_string_lossy());
    }

    #[test]
    fn mic_and_computer_sound_are_mixed_at_full_level() {
        let mut j = job(vec![seg(1_000_000, 3_000_000, 0), seg(4_000_000, 5_000_000, 2_000_000)], Some(mic(12_400)), 3_000_000);
        j.system = Some(MicJob { file: "system.wav".into(), offset_us: 0, volume: 1.0, muted: false, ..Default::default() });
        let f = audio_filter_with(&j, Some(10_000_000)).unwrap();
        assert!(f.contains("[1:a]aresample"), "{f}");
        assert!(f.contains("[2:a]aresample"), "{f}");
        assert!(f.contains("[k1s0]atrim=start=1.000000:end=3.000000"), "{f}");
        assert!(f.contains("atrim=start=0.987600:end=2.987600"), "{f}");
        assert!(f.contains("[t0][t1]amix=inputs=2:duration=longest:normalize=0,apad,atrim=end=3.000000[aout]"), "{f}");
        let args = ffmpeg_args(&j);
        let sys = PathBuf::from("proj").join("system.wav").to_string_lossy().to_string();
        let mic_i = args.iter().position(|a| a.ends_with("mic.wav")).unwrap();
        let sys_i = args.iter().position(|a| a == &sys).unwrap();
        assert!(mic_i < sys_i, "mic is input 1, computer sound input 2");
    }

    #[test]
    fn computer_sound_alone_when_the_mic_is_muted_or_missing() {
        let mut m = mic(0);
        m.muted = true;
        let mut j = job(vec![seg(0, 1_000_000, 0)], Some(m), 1_000_000);
        j.system = Some(MicJob { file: "system.wav".into(), offset_us: 0, volume: 0.5, muted: false, ..Default::default() });
        let f = audio_filter(&j).unwrap();
        assert!(f.starts_with("[1:a]"), "{f}");
        assert!(!f.contains("amix"), "{f}");
        assert!(f.contains("volume=0.5[t0]"), "{f}");
        assert!(ffmpeg_args(&j).join(" ").contains("system.wav"));
    }

    #[test]
    fn fades_follow_the_volume_in_output_time() {
        let mut m = mic(0);
        m.volume = 0.8;
        m.fade_in_us = 500_000;
        m.fade_out_us = 2_000_000;
        let j = job(vec![seg(0, 3_000_000, 0), seg(4_000_000, 6_000_000, 3_000_000)], Some(m), 5_000_000);
        let f = audio_filter_with(&j, Some(10_000_000)).unwrap();
        assert!(f.contains("volume=0.8,afade=t=in:st=0:d=0.500000,afade=t=out:st=3.000000:d=2.000000[t0]"), "{f}");
    }

    #[test]
    fn fades_longer_than_the_video_are_capped() {
        let mut m = mic(0);
        m.fade_out_us = 9_000_000;
        let j = job(vec![seg(0, 1_000_000, 0)], Some(m), 1_000_000);
        let f = audio_filter_with(&j, Some(10_000_000)).unwrap();
        assert!(f.contains("afade=t=out:st=0.000000:d=1.000000[t0]"), "{f}");
        assert!(!f.contains("t=in"), "{f}");
    }

    #[test]
    fn each_track_gets_its_own_fades() {
        let mut j = job(vec![seg(0, 4_000_000, 0)], Some(mic(0)), 4_000_000);
        j.system = Some(MicJob { file: "system.wav".into(), offset_us: 0, volume: 1.0, muted: false, fade_in_us: 1_000_000, ..Default::default() });
        let f = audio_filter_with(&j, Some(10_000_000)).unwrap();
        assert!(f.contains("volume=1[t0]"), "mic has no fade: {f}");
        assert!(f.contains("volume=1,afade=t=in:st=0:d=1.000000[t1]"), "{f}");
    }

    #[test]
    fn clean_mic_reads_the_cached_copy() {
        let mut m = mic(0);
        m.clean = true;
        let j = job(vec![seg(0, 1_000_000, 0)], Some(m), 1_000_000);
        let args = ffmpeg_args(&j);
        let want = PathBuf::from("proj").join("cache").join("mic.clean.wav").to_string_lossy().to_string();
        assert!(args.contains(&want), "{args:?}");
        let raw = PathBuf::from("proj").join("mic.wav").to_string_lossy().to_string();
        assert!(!args.contains(&raw), "{args:?}");
    }

    #[test]
    fn loudness_tail_ends_the_graph_only_when_asked_and_measured() {
        let m = Loudness { i: -21.8, thresh: -32.4, lra: 9.6, tp: -1.7 };
        let mut j = job(vec![seg(0, 1_000_000, 0)], Some(mic(0)), 1_000_000);
        // Measured but not asked for: no tail.
        assert!(!audio_filter_loud(&j, Some(&m)).unwrap().contains("loudnorm"));
        j.normalize = Some(crate::Normalize { target_lufs: -14.0 });
        assert!(!audio_filter_loud(&j, None).unwrap().contains("loudnorm"), "not measured: no tail");
        let f = audio_filter_loud(&j, Some(&m)).unwrap();
        assert!(f.ends_with("apad,atrim=end=1.000000,loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-21.80:measured_TP=-1.70:measured_LRA=9.60:measured_thresh=-32.40:offset=0:linear=true,aresample=48000[aout]"), "{f}");
        let args = ffmpeg_args_loud(&j, Some(&m)).join(" ");
        assert!(args.contains("loudnorm=I=-14"), "{args}");
    }

    #[test]
    fn measure_args_run_the_same_graph_into_ebur128() {
        let mut j = job(vec![seg(0, 1_000_000, 0)], Some(mic(0)), 1_000_000);
        j.normalize = Some(crate::Normalize { target_lufs: -14.0 });
        let a = crate::loudness::measure_args(&j).unwrap();
        let s = a.join(" ");
        assert!(s.contains(";[aout]ebur128=peak=true:framelog=quiet[m] -map [m] -f null -"), "{s}");
        assert!(!s.contains("loudnorm"), "{s}");
        assert!(s.contains("mic.wav"), "{s}");
        let mut silent = j.clone();
        silent.mic = None;
        assert_eq!(crate::loudness::measure_args(&silent), None);
    }

    #[test]
    fn job_reads_new_audio_fields_and_defaults_them() {
        let json = r#"{"projectDir":"p","outPath":"o.mp4","width":1920,"height":1080,"fps":30,
            "segments":[{"srcStartUs":0,"srcEndUs":1000000,"outStartUs":0}],
            "mic":{"file":"mic.wav","offsetUs":0,"volume":1.0,"muted":false,"fadeInUs":500000,"clean":true},
            "outputDurationUs":1000000,"normalize":{"targetLufs":-14}}"#;
        let j: ExportJob = serde_json::from_str(json).unwrap();
        let m = j.mic.unwrap();
        assert_eq!((m.fade_in_us, m.fade_out_us, m.clean), (500_000, 0, true));
        assert_eq!(j.normalize.unwrap().target_lufs, -14.0);
    }

    #[test]
    fn job_reads_camel_case_json() {
        let json = r#"{"projectDir":"p","outPath":"o.mp4","width":1920,"height":1080,"fps":30,
            "segments":[{"srcStartUs":0,"srcEndUs":1000000,"outStartUs":0}],
            "mic":{"file":"mic.wav","offsetUs":12400,"volume":1.0,"muted":false},"outputDurationUs":1000000}"#;
        let j: ExportJob = serde_json::from_str(json).unwrap();
        assert_eq!(j.segments[0].src_end_us, 1_000_000);
        assert_eq!(j.mic.unwrap().offset_us, 12_400);
    }
}
