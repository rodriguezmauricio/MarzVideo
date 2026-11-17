//! FFmpeg argument and audio filter builders.

use crate::ExportJob;
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

/// The mic file path when the mic is used (present and not muted).
fn mic_path(job: &ExportJob) -> Option<PathBuf> {
    job.mic.as_ref().filter(|m| !m.muted).map(|m| job.project_dir.join(&m.file))
}

/// The `-filter_complex` graph that cuts the mic to the kept segments, ending in the `[aout]` pad.
/// The mic is input 1. None when there is no usable mic (no mic, muted, or no segments): the caller
/// then writes a silent track.
///
/// Each segment is mapped to the mic timeline by subtracting `offset_us`. A segment that starts
/// before the mic is padded with silence at its start (`adelay`); one that ends before the mic
/// starts is pure silence. Every segment is padded to its exact length so a short mic file cannot
/// shift the segments after it.
pub fn audio_filter(job: &ExportJob) -> Option<String> {
    let mic = job.mic.as_ref().filter(|m| !m.muted)?;
    let segs: Vec<_> = job.segments.iter().filter(|s| s.src_end_us > s.src_start_us).collect();
    if segs.is_empty() {
        return None;
    }
    let offset = mic.offset_us;
    // Segments that read the mic (the others are silence made from nothing).
    let readers = segs.iter().filter(|s| s.src_end_us - offset > 0).count();

    let mut parts: Vec<String> = Vec::new();
    // One format for every branch so `concat` accepts them: 48 kHz mono float.
    let norm = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono";
    match readers {
        0 => {}
        1 => parts.push(format!("[1:a]{norm}[s0]")),
        n => {
            let outs: String = (0..n).map(|i| format!("[s{i}]")).collect();
            parts.push(format!("[1:a]{norm},asplit={n}{outs}"));
        }
    }
    let mut reader = 0;
    let mut labels = String::new();
    for (i, s) in segs.iter().enumerate() {
        let len = s.src_end_us - s.src_start_us;
        let mic_start = s.src_start_us - offset;
        let mic_end = s.src_end_us - offset;
        if mic_end <= 0 {
            parts.push(format!("anullsrc=r=48000:cl=mono:d={},aformat=sample_fmts=fltp[a{i}]", secs(len)));
        } else {
            let mut chain = format!("[s{reader}]atrim=start={}:end={},asetpts=PTS-STARTPTS", secs(mic_start), secs(mic_end));
            if mic_start < 0 {
                chain.push_str(&format!(",adelay={}:all=1", millis(-mic_start)));
            }
            chain.push_str(&format!(",apad=whole_dur={}[a{i}]", secs(len)));
            parts.push(chain);
            reader += 1;
        }
        labels.push_str(&format!("[a{i}]"));
    }
    parts.push(format!(
        "{labels}concat=n={}:v=0:a=1,volume={},apad,atrim=end={}[aout]",
        segs.len(),
        mic.volume,
        secs(job.output_duration_us)
    ));
    Some(parts.join(";"))
}

/// The full FFmpeg command line (without the program). Video comes as H.264 annexb on stdin and is
/// copied; audio is the filtered mic or a silent track. Output is `<out_path>.part` as MP4.
pub fn ffmpeg_args(job: &ExportJob) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
    push(&["-hide_banner", "-loglevel", "warning", "-y"]);
    push(&["-f", "h264", "-framerate", &job.fps.to_string(), "-i", "pipe:0"]);
    match (audio_filter(job), mic_path(job)) {
        (Some(graph), Some(path)) => {
            push(&["-i", &path.to_string_lossy()]);
            push(&["-filter_complex", &graph, "-map", "0:v:0", "-map", "[aout]"]);
        }
        _ => {
            push(&["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono"]);
            push(&["-map", "0:v:0", "-map", "1:a:0"]);
        }
    }
    push(&["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]);
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
            output_duration_us: dur_us,
        }
    }

    fn seg(s: i64, e: i64, o: i64) -> Segment {
        Segment { src_start_us: s, src_end_us: e, out_start_us: o }
    }

    fn mic(offset_us: i64) -> MicJob {
        MicJob { file: "mic.wav".into(), offset_us, volume: 1.0, muted: false }
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
    fn job_reads_camel_case_json() {
        let json = r#"{"projectDir":"p","outPath":"o.mp4","width":1920,"height":1080,"fps":30,
            "segments":[{"srcStartUs":0,"srcEndUs":1000000,"outStartUs":0}],
            "mic":{"file":"mic.wav","offsetUs":12400,"volume":1.0,"muted":false},"outputDurationUs":1000000}"#;
        let j: ExportJob = serde_json::from_str(json).unwrap();
        assert_eq!(j.segments[0].src_end_us, 1_000_000);
        assert_eq!(j.mic.unwrap().offset_us, 12_400);
    }
}
