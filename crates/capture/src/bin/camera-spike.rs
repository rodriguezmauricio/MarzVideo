//! Camera spike (Task 0 of docs/superpowers/plans/2026-11-18-camera-track.md). Throwaway: deleted
//! once the findings are in docs/spikes/2026-11-19-camera-spike.md.
//!
//! ```text
//! camera-spike list
//! camera-spike read <secs> [--encode out.mp4] [--name substring]
//! ```
//! `read` opens the camera (MJPEG/YUY2 decoded to NV12 by the Source Reader), reads frames for
//! `secs` and prints, per frame, the sample time, the device QPC timestamp and the QPC now, then a
//! summary (fps, gaps, how old frames are when they arrive). `--encode` pipes NV12 into FFmpeg.

#[cfg(not(windows))]
fn main() {
    eprintln!("camera-spike runs on Windows only");
}

#[cfg(windows)]
fn main() {
    if let Err(e) = imp::run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod imp {
    use marz_capture::win::qpc::qpc_hns;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use windows::core::{GUID, PWSTR};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};

    const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

    struct Cam {
        name: String,
        act: IMFActivate,
    }

    fn cameras() -> windows::core::Result<Vec<Cam>> {
        unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 1)?;
            let attrs = attrs.unwrap();
            attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)?;
            let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut n = 0u32;
            MFEnumDeviceSources(&attrs, &mut list, &mut n)?;
            let mut out = Vec::new();
            for i in 0..n as usize {
                if let Some(act) = (*list.add(i)).take() {
                    let mut p = PWSTR::null();
                    let mut len = 0u32;
                    act.GetAllocatedString(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &mut p, &mut len)?;
                    let name = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as _));
                    out.push(Cam { name, act });
                }
            }
            CoTaskMemFree(Some(list as _));
            Ok(out)
        }
    }

    fn fourcc(g: &GUID) -> String {
        let d = g.data1.to_le_bytes();
        if d.iter().all(|b| b.is_ascii_graphic()) { String::from_utf8_lossy(&d).into_owned() } else { format!("{:08x}", g.data1) }
    }

    struct Mode {
        index: u32,
        sub: GUID,
        w: u32,
        h: u32,
        fps: f64,
    }

    fn modes(reader: &IMFSourceReader) -> Vec<Mode> {
        let mut out = Vec::new();
        for i in 0.. {
            let Ok(t) = (unsafe { reader.GetNativeMediaType(STREAM, i) }) else { break };
            unsafe {
                let sub = t.GetGUID(&MF_MT_SUBTYPE).unwrap_or_default();
                let size = t.GetUINT64(&MF_MT_FRAME_SIZE).unwrap_or(0);
                let rate = t.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or(0);
                let (num, den) = ((rate >> 32) as f64, (rate & 0xffff_ffff) as f64);
                out.push(Mode { index: i, sub, w: (size >> 32) as u32, h: (size & 0xffff_ffff) as u32, fps: if den > 0.0 { num / den } else { 0.0 } });
            }
        }
        out
    }

    fn open(cam: &Cam) -> windows::core::Result<IMFSourceReader> {
        unsafe {
            let source: IMFMediaSource = cam.act.ActivateObject()?;
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 1)?;
            let attrs = attrs.unwrap();
            attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)?;
            MFCreateSourceReaderFromMediaSource(&source, &attrs)
        }
    }

    pub fn run() -> Result<(), String> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| e.to_string())?;
        }
        let cams = cameras().map_err(|e| format!("enumerate: {e}"))?;
        match args.first().map(String::as_str) {
            Some("list") => {
                for c in &cams {
                    println!("camera: {}", c.name);
                    match open(c) {
                        Ok(r) => {
                            for m in modes(&r) {
                                println!("  {:>2} {} {}x{} {:.2} fps", m.index, fourcc(&m.sub), m.w, m.h, m.fps);
                            }
                        }
                        Err(e) => println!("  could not open: {e}"),
                    }
                }
                Ok(())
            }
            Some("read") => {
                let secs: f64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(5.0);
                let encode = args.iter().position(|a| a == "--encode").and_then(|i| args.get(i + 1)).cloned();
                let want = args.iter().position(|a| a == "--name").and_then(|i| args.get(i + 1)).cloned();
                let cam = cams
                    .iter()
                    .find(|c| want.as_ref().is_none_or(|w| c.name.contains(w.as_str())))
                    .ok_or("no camera")?;
                read(cam, secs, encode)
            }
            _ => Err("usage: camera-spike list | read <secs> [--encode out.mp4] [--name substring]".into()),
        }
    }

    fn read(cam: &Cam, secs: f64, encode: Option<String>) -> Result<(), String> {
        let t_open = qpc_hns();
        let reader = open(cam).map_err(|e| format!("open: {e}"))?;
        // Highest mode at or below 1920 x 1080 that reaches 30 fps.
        let ms = modes(&reader);
        let best = ms
            .iter()
            .filter(|m| m.w <= 1920 && m.h <= 1080 && m.fps >= 29.9)
            .max_by_key(|m| (m.w * m.h, (m.sub == MFVideoFormat_NV12) as u8))
            .ok_or("no 30 fps mode")?;
        println!("camera: {} mode {} {}x{} {:.2} fps", cam.name, fourcc(&best.sub), best.w, best.h, best.fps);
        let (w, h) = (best.w, best.h);
        unsafe {
            let native = reader.GetNativeMediaType(STREAM, best.index).map_err(|e| e.to_string())?;
            reader.SetCurrentMediaType(STREAM, None, &native).map_err(|e| format!("set native: {e}"))?;
            let out = MFCreateMediaType().map_err(|e| e.to_string())?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(w) << 32) | u64::from(h)).map_err(|e| e.to_string())?;
            reader.SetCurrentMediaType(STREAM, None, &out).map_err(|e| format!("set nv12: {e}"))?;
        }
        let mut ff = encode.map(|path| {
            Command::new("ffmpeg")
                .args(["-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pix_fmt", "nv12", "-s", &format!("{w}x{h}"), "-r", "30", "-i", "pipe:0"])
                .args(["-c:v", "h264_nvenc", "-preset", "p4", "-bf", "0", "-g", "30", "-movflags", "frag_keyframe+empty_moov+default_base_moof", &path])
                .stdin(Stdio::piped())
                .spawn()
                .expect("ffmpeg")
        });
        let start = qpc_hns();
        let mut first_frame_at: Option<i64> = None;
        let (mut n, mut last_dev, mut max_gap, mut age_sum, mut age_max, mut bytes_bad) = (0u64, 0i64, 0i64, 0i64, 0i64, 0u64);
        let mut decode_hns = 0i64;
        while (qpc_hns() - start) as f64 / 1e7 < secs {
            let mut flags = 0u32;
            let mut ts = 0i64;
            let mut sample: Option<IMFSample> = None;
            let t_call = qpc_hns();
            unsafe { reader.ReadSample(STREAM, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample)) }.map_err(|e| format!("read: {e}"))?;
            let now = qpc_hns();
            decode_hns += now - t_call;
            let Some(s) = sample else { continue };
            first_frame_at.get_or_insert(now);
            let dev = unsafe { s.GetUINT64(&MFSampleExtension_DeviceTimestamp) }.map(|v| v as i64).unwrap_or(-1);
            let age = now - dev;
            if n > 0 && dev > 0 {
                max_gap = max_gap.max(dev - last_dev);
            }
            if n >= 5 {
                age_sum += age;
                age_max = age_max.max(age);
            }
            if n < 5 || n % 30 == 0 {
                println!("frame {n:>4} sample_ts {:>10.1} ms  device_qpc {:>14}  qpc_now {:>14}  age {:>6.1} ms", ts as f64 / 1e4, dev, now, age as f64 / 1e4);
            }
            last_dev = dev;
            if let Some(child) = ff.as_mut() {
                unsafe {
                    let buf = s.ConvertToContiguousBuffer().map_err(|e| e.to_string())?;
                    let mut p = std::ptr::null_mut();
                    let mut len = 0u32;
                    buf.Lock(&mut p, None, Some(&mut len)).map_err(|e| e.to_string())?;
                    let expect = (w * h * 3 / 2) as usize;
                    if len as usize != expect {
                        bytes_bad += 1;
                    }
                    let data = std::slice::from_raw_parts(p, (len as usize).min(expect));
                    let _ = child.stdin.as_mut().unwrap().write_all(data);
                    let _ = buf.Unlock();
                }
            }
            n += 1;
        }
        let el = (qpc_hns() - start) as f64 / 1e7;
        println!("summary: open to first frame {:.0} ms, {n} frames in {el:.2} s = {:.2} fps, max device gap {:.1} ms, mean age {:.1} ms, max age {:.1} ms, read time {:.1} ms/frame, bad sizes {bytes_bad}",
            (first_frame_at.unwrap_or(start) - t_open) as f64 / 1e4,
            n as f64 / el,
            max_gap as f64 / 1e4,
            if n > 5 { age_sum as f64 / (n - 5) as f64 / 1e4 } else { 0.0 },
            age_max as f64 / 1e4,
            decode_hns as f64 / n.max(1) as f64 / 1e4);
        if let Some(mut child) = ff {
            drop(child.stdin.take());
            let _ = child.wait();
        }
        Ok(())
    }
}
