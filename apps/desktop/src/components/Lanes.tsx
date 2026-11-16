import { useEffect, useState } from "react";

/** How many still frames are grabbed for the Screen lane, at most. Thumbs reuse the nearest one. */
const MAX_FRAMES = 60;
const FRAME_W = 192;

/** Grab still frames from the screen track (raw file is only read) for the thumbnail strip. */
function useFrames(url: string, durationUs: number): string[] {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    const canvas = document.createElement("canvas");
    const n = Math.max(2, Math.min(MAX_FRAMES, Math.ceil(durationUs / 1e6)));
    const out: string[] = [];
    const seekTo = (s: number) =>
      new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("thumbnail video failed"));
        video.currentTime = s;
      });
    video.onloadeddata = async () => {
      canvas.width = FRAME_W;
      canvas.height = Math.round((FRAME_W * video.videoHeight) / Math.max(1, video.videoWidth));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        for (let i = 0; i < n && !cancelled; i++) {
          await seekTo(Math.min(video.duration - 0.05, ((i / (n - 1)) * durationUs) / 1e6));
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL("image/jpeg", 0.7));
          if (!cancelled && (i === 0 || i === n - 1 || i % 8 === 0)) setFrames([...out]);
        }
      } catch {
        /* the strip stays partly empty; the editor still works */
      }
    };
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [url, durationUs]);
  return frames;
}

/** Screen lane: 16:9 thumbnails, 1px apart, from the start of the track. */
export function ScreenThumbs(props: { url: string; durationUs: number; widthPx: number; pps: number; rowH: number }) {
  const frames = useFrames(props.url, props.durationUs);
  const h = props.rowH - 6;
  const w = Math.round((h * 16) / 9);
  const count = Math.ceil(props.widthPx / (w + 1));
  const thumbs = [];
  for (let i = 0; i < count; i++) {
    const left = i * (w + 1);
    const us = (left / props.pps) * 1e6;
    const idx = frames.length > 1 ? Math.round((us / props.durationUs) * (frames.length - 1)) : 0;
    const src = frames[Math.min(frames.length - 1, idx)];
    thumbs.push(
      <div key={i} className="thumb" style={{ left, width: w, height: h }}>
        {src && <img src={src} alt="" draggable={false} />}
      </div>,
    );
  }
  return <>{thumbs}</>;
}

const PEAK_BUCKETS_PER_S = 100;

/** Peak level per 10 ms of the mic track (raw file is only read), 0..1. */
function usePeaks(url: string | undefined): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const per = Math.max(1, Math.floor(audio.sampleRate / PEAK_BUCKETS_PER_S));
        const out = new Float32Array(Math.ceil(data.length / per));
        let max = 0;
        for (let b = 0; b < out.length; b++) {
          let m = 0;
          for (let i = b * per, end = Math.min(data.length, i + per); i < end; i++) m = Math.max(m, Math.abs(data[i]!));
          out[b] = m;
          max = Math.max(max, m);
        }
        if (max > 0) for (let b = 0; b < out.length; b++) out[b] = out[b]! / max;
        if (!cancelled) setPeaks(out);
      } catch {
        /* no waveform; the lane stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  return peaks;
}

/** Mic lane: bars 2px wide every 4px. */
export function MicWave(props: { url: string; offsetUs: number; widthPx: number; pps: number; rowH: number }) {
  const peaks = usePeaks(props.url);
  const mid = props.rowH / 2;
  const maxHalf = mid - 6;
  let d = "";
  for (let x = 2; x < props.widthPx; x += 4) {
    let amp = 0;
    if (peaks) {
      const b0 = Math.floor((((x - 2) / props.pps) * 1e6 - props.offsetUs) / (1e6 / PEAK_BUCKETS_PER_S));
      const b1 = Math.floor((((x + 2) / props.pps) * 1e6 - props.offsetUs) / (1e6 / PEAK_BUCKETS_PER_S));
      for (let b = Math.max(0, b0); b <= b1 && b < peaks.length; b++) amp = Math.max(amp, peaks[b]!);
    }
    const half = Math.max(1, amp * maxHalf);
    d += `M${x} ${(mid - half).toFixed(1)}V${(mid + half).toFixed(1)}`;
  }
  return (
    <svg className="wave" width={props.widthPx} height={props.rowH} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
