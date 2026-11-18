//! Pipe check: pushes synthetic BGRA frames into the FFmpeg sidecar (`ScreenEncoder`, the same
//! arguments the recorder uses) at 1920x1080, 2560x1440 and 3840x2160, and prints the sustained
//! frame rate and CPU. No screen, window or sound is involved.
//!
//! ```text
//! pipe-bench [--secs N] [--fps N] [--encoder E] [--res WxH,WxH,...]
//! ```
//!
//! Frames are written on a fixed schedule (frame i is due at i / fps). When the encoder cannot
//! keep up the pipe fills, the write blocks and the sustained rate falls below the target.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use marz_capture::CaptureError;
use marz_capture::ffmpeg::{ScreenEncoder, find_ffmpeg, probe_encoder, screen_args};
use marz_capture::slots::FrameSink;

const USAGE: &str = "usage: pipe-bench [--secs N] [--fps N] [--encoder E] [--res WxH,WxH,...]";
/// Different frames cycled through, so the encoder sees motion and not a still picture.
const PATTERNS: usize = 4;
/// Sustained rate that counts as holding the target (2% under).
const HOLD_RATIO: f64 = 0.98;

struct Args {
    secs: f64,
    fps: u32,
    encoder: Option<String>,
    resolutions: Vec<(u32, u32)>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    let mut a = Args { secs: 20.0, fps: 60, encoder: None, resolutions: vec![(1920, 1080), (2560, 1440), (3840, 2160)] };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = |what: &str| it.next().cloned().ok_or_else(|| format!("{flag} needs {what}"));
        match flag.as_str() {
            "--secs" => a.secs = value("a number")?.parse().map_err(|_| "--secs needs a number".to_string())?,
            "--fps" => a.fps = value("a number")?.parse().map_err(|_| "--fps needs a number".to_string())?,
            "--encoder" => a.encoder = Some(value("a name")?),
            "--res" => {
                a.resolutions = value("a list like 1920x1080,2560x1440")?
                    .split(',')
                    .map(|r| {
                        let (w, h) = r.trim().split_once('x').ok_or_else(|| format!("{r} is not WxH"))?;
                        Ok((w.parse().map_err(|_| format!("{r} is not WxH"))?, h.parse().map_err(|_| format!("{r} is not WxH"))?))
                    })
                    .collect::<Result<_, String>>()?;
            }
            other => return Err(format!("unknown flag: {other}")),
        }
    }
    if a.fps == 0 || a.secs <= 0.0 {
        return Err("--fps and --secs must be above 0".into());
    }
    Ok(a)
}

/// A synthetic frame: a horizontal gradient that scrolls with `phase`, plus cheap noise in the low
/// bits, so consecutive frames differ everywhere like a moving picture.
fn pattern(w: u32, h: u32, phase: u32) -> Vec<u8> {
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let mut s = 0x9E37_79B9u32 ^ phase.wrapping_mul(0x85EB_CA6B);
    for (i, px) in buf.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let x = (i as u32) % w;
        let y = (i as u32) / w;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let g = (x.wrapping_add(phase * 40) % 256) as u8;
        px[0] = g ^ (s as u8 & 7);
        px[1] = ((y / 4) as u8).wrapping_add(phase as u8 * 16);
        px[2] = g.wrapping_mul(3);
        px[3] = 255;
    }
    buf
}

#[cfg(windows)]
fn process_cpu_s(pid: Option<u32>) -> f64 {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let (h, own) = match pid {
        None => (unsafe { GetCurrentProcess() }, true),
        Some(pid) => match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(h) => (h, false),
            Err(_) => return 0.0,
        },
    };
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    let ok = unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) }.is_ok();
    if !own {
        let _ = unsafe { CloseHandle(h) };
    }
    if !ok {
        return 0.0;
    }
    let ft = |f: FILETIME| ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 1e7;
    ft(k) + ft(u)
}

#[cfg(not(windows))]
fn process_cpu_s(_pid: Option<u32>) -> f64 {
    0.0
}

struct Row {
    w: u32,
    h: u32,
    frames: u64,
    elapsed: f64,
    fps: f64,
    max_write_ms: f64,
    steady_max_write_ms: f64,
    late: u64,
    steady_late: u64,
    bench_cpu: f64,
    ffmpeg_cpu: f64,
    flush_s: f64,
    mbit: f64,
}

fn bench(ffmpeg: &std::path::Path, encoder: &str, w: u32, h: u32, a: &Args) -> Result<Row, CaptureError> {
    let out: PathBuf = std::env::temp_dir().join(format!("marz-pipe-bench-{w}x{h}-{}.mp4", std::process::id()));
    let args = screen_args(encoder, w, h, a.fps, &out);
    let mut enc = ScreenEncoder::spawn(ffmpeg, &args)?;
    let pid = enc.id();
    let frames: Vec<Vec<u8>> = (0..PATTERNS as u32).map(|p| pattern(w, h, p)).collect();
    let total = (a.secs * f64::from(a.fps)).round() as u64;
    let slot = Duration::from_secs_f64(1.0 / f64::from(a.fps));

    let cpu0 = (process_cpu_s(None), process_cpu_s(Some(pid)));
    let start = Instant::now();
    let mut max_write = Duration::ZERO;
    let mut steady_max_write = Duration::ZERO;
    let mut late = 0u64;
    let mut steady_late = 0u64;
    let mut sent = 0u64;
    for i in 0..total {
        let due = start + slot.mul_f64(i as f64);
        let now = Instant::now();
        if now < due {
            std::thread::sleep(due - now);
        }
        let t = Instant::now();
        if enc.write(&frames[(i as usize) % PATTERNS]).is_err() {
            break; // the encoder died; finish() reports why
        }
        sent += 1;
        let took = t.elapsed();
        max_write = max_write.max(took);
        let is_late = Instant::now() > due + slot;
        late += u64::from(is_late);
        // The first second includes the encoder opening (the same hitch the recorder has at its start).
        if i >= u64::from(a.fps) {
            steady_max_write = steady_max_write.max(took);
            steady_late += u64::from(is_late);
        }
    }
    let elapsed = start.elapsed().as_secs_f64();
    let cpu1 = (process_cpu_s(None), process_cpu_s(Some(pid)));
    let flush = Instant::now();
    enc.finish()?;
    let flush_s = flush.elapsed().as_secs_f64();
    let bytes = std::fs::metadata(&out).map_or(0, |m| m.len()) as f64;
    let _ = std::fs::remove_file(&out);
    Ok(Row {
        w,
        h,
        frames: sent,
        elapsed,
        fps: sent as f64 / elapsed,
        max_write_ms: max_write.as_secs_f64() * 1000.0,
        steady_max_write_ms: steady_max_write.as_secs_f64() * 1000.0,
        late,
        steady_late,
        bench_cpu: (cpu1.0 - cpu0.0) / elapsed * 100.0,
        ffmpeg_cpu: (cpu1.1 - cpu0.1) / elapsed * 100.0,
        flush_s,
        mbit: bytes * 8.0 / 1e6 / elapsed,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a = match parse(&args) {
        Ok(a) => a,
        Err(m) => {
            eprintln!("{m}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let ffmpeg = match find_ffmpeg() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };
    let encoder = a.encoder.clone().unwrap_or_else(|| probe_encoder(&ffmpeg));
    println!("pipe-bench: encoder {encoder}, {} s per size, target {} fps, synthetic BGRA frames ({PATTERNS} patterns cycled)", a.secs, a.fps);
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    println!("cores: {cores}  (CPU is percent of one core)");
    println!(
        "{:<10} {:>7} {:>8} {:>9} {:>11} {:>12} {:>5} {:>12} {:>9} {:>10} {:>8} {:>7}  result",
        "size", "frames", "secs", "fps", "max write", "steady max", "late", "steady late", "bench cpu", "ffmpeg cpu", "flush s", "Mbit/s"
    );
    let mut failed = false;
    for &(w, h) in &a.resolutions {
        match bench(&ffmpeg, &encoder, w, h, &a) {
            Ok(r) => {
                let held = r.fps >= f64::from(a.fps) * HOLD_RATIO;
                println!(
                    "{:<10} {:>7} {:>8.2} {:>9.2} {:>8.1} ms {:>9.1} ms {:>5} {:>12} {:>8.0}% {:>9.0}% {:>8.2} {:>7.1}  {}",
                    format!("{}x{}", r.w, r.h),
                    r.frames,
                    r.elapsed,
                    r.fps,
                    r.max_write_ms,
                    r.steady_max_write_ms,
                    r.late,
                    r.steady_late,
                    r.bench_cpu,
                    r.ffmpeg_cpu,
                    r.flush_s,
                    r.mbit,
                    if held { "holds" } else { "BELOW TARGET" }
                );
            }
            Err(e) => {
                println!("{:<10} error: {e}", format!("{w}x{h}"));
                failed = true;
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}
