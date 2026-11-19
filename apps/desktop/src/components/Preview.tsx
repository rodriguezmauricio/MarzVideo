import { useEffect, useMemo, useRef } from "react";
import { canvasMeasure, captionLayout, cameraLayout, cameraMediaUs, drawCaptions, drawFrame, frameAt, type CaptionStyle } from "@marz/compositor";
import { keptSegments, outputToSource, sourceToOutput } from "@marz/timeline";
import { captionStyleFor } from "@marz/format";
import { captionBlocks, captionStyle, loadCaptionFont } from "../ai/captionStyle";
import { useEditorStore } from "../state/editorStore";
import { mediaTimeUs, nextPlaybackTime, playbackEnded, sourceTimeUs, startTimeForPlay } from "../playback/clock";
import { readFirstFrameUs } from "../playback/firstFrame";
import { mmss } from "./timecode";
import { ZoomOverlay } from "./ZoomOverlay";

const AUDIO_DRIFT_S = 0.04;
/** Camera sync while playing: a seek past this gap, else a small speed nudge (a video seek lands late
 *  on a decoder that has to start at a keyframe, so seeking for small gaps never settles). */
const CAMERA_SEEK_S = 0.25;
const CAMERA_LOCK_S = 0.012;

export function Preview() {
  const project = useEditorStore((s) => s.project)!;
  const storage = useEditorStore((s) => s.storage)!;
  const playing = useEditorStore((s) => s.playing);
  const seekRequest = useEditorStore((s) => s.seekRequest);
  const selection = useEditorStore((s) => s.selection);
  const selectedZoom = selection?.kind === "zoom" ? project.edits.zooms.find((z) => z.id === selection.id) : undefined;
  // While a zoom is selected (and not playing) show the full frame so its area can be edited on the canvas.
  const editingZoom = selectedZoom && !playing ? selectedZoom : undefined;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sysRef = useRef<HTMLAudioElement>(null);
  const camRef = useRef<HTMLVideoElement>(null);
  const cam = project.tracks.camera;

  const segs = useMemo(() => keptSegments(project.durationUs, project.edits.cuts), [project.durationUs, project.edits.cuts]);
  // Presentation time of frame 0 in screen.mp4 (0 without B-frames). 0 until the file's start is read.
  const firstFrame = useRef(0);
  const mic = project.tracks.mic;
  const sys = project.tracks.system;
  type AudioTrack = NonNullable<typeof mic>;
  /** The audio elements with their tracks: the mic and the computer's sound. */
  const audios = (): [HTMLAudioElement, AudioTrack][] =>
    (
      [
        [audioRef.current, mic],
        [sysRef.current, sys],
      ] as const
    ).filter((p): p is [HTMLAudioElement, AudioTrack] => !!p[0] && !!p[1]);

  const words = useEditorStore((s) => s.words);
  const preset = useEditorStore((s) => s.captionPreset);
  const look = useMemo(() => captionStyleFor(project, preset), [project, preset]);
  const blocks = useMemo(() => captionBlocks(project, words, look), [project, words, look]);
  const style = useRef<CaptionStyle | null>(null);

  // Latest values for the animation loop without restarting it.
  const live = useRef({ project, segs, editing: false, blocks, look });
  live.current = { project, segs, editing: !!editingZoom, blocks, look };

  const draw = () => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || video.readyState < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The export's setting, so the scaled camera looks the same in both.
    ctx.imageSmoothingQuality = "high";
    const { project: p, editing } = live.current;
    const srcUs = sourceTimeUs(p, Math.round(video.currentTime * 1e6), firstFrame.current);
    const { events } = useEditorStore.getState();
    const shown = editing ? { ...p, edits: { ...p.edits, zooms: [] } } : p;
    const layout = cameraLayout(p, p.output);
    const camVideo = camRef.current;
    const camera = layout && camVideo && camVideo.readyState >= 2 ? { source: camVideo, ...layout } : null;
    drawFrame(ctx, video, frameAt(shown, events, srcUs), p.output, camera);
    // Captions: the same layout and drawing as the export (DESIGN-SYSTEM.md "Captions in the video").
    const { blocks: bl, look: lk, segs: sg } = live.current;
    const tOut = bl.length ? sourceToOutput(sg, srcUs) : null;
    if (tOut !== null) {
      try {
        style.current ??= captionStyle();
        const st = style.current;
        const d = captionLayout(bl, tOut, lk, p.output, { x: 0, y: 0, w: p.output.width, h: p.output.height }, canvasMeasure(ctx, st.family));
        if (d) drawCaptions(ctx, d, st);
      } catch (e) {
        console.warn("captions not drawn", e);
      }
    }
  };

  /** Camera media time (s) for source time `srcUs`, held on its last frame past its end. */
  const cameraTimeS = (srcUs: number) => {
    const v = camRef.current;
    const t = cameraMediaUs(live.current.project, srcUs) / 1e6;
    return v && Number.isFinite(v.duration) ? Math.min(t, Math.max(0, v.duration - 0.001)) : t;
  };

  const seekMedia = (srcUs: number) => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) video.currentTime = Math.max(0, mediaTimeUs(project, srcUs, firstFrame.current) / 1e6);
    for (const [audio, track] of audios()) audio.currentTime = Math.max(0, (srcUs - track.offsetUs) / 1e6);
    if (camRef.current && cam) camRef.current.currentTime = cameraTimeS(srcUs);
  };

  // Read where frame 0 sits in screen.mp4 (a Range request on the file's start), then show the playhead again.
  const screenUrl = storage.fileUrl(project.tracks.screen.file);
  useEffect(() => {
    let active = true;
    void readFirstFrameUs(screenUrl).then((us) => {
      if (!active || us === firstFrame.current) return;
      firstFrame.current = us;
      seekMedia(useEditorStore.getState().playheadUs);
    });
    return () => {
      active = false;
    };
  }, [screenUrl]);

  // User seeks.
  useEffect(() => {
    seekMedia(seekRequest.us);
  }, [seekRequest]);

  // Redraw when the video lands on a new frame while paused, and whenever edits change.
  useEffect(() => {
    const els = [videoRef.current, camRef.current];
    for (const v of els) {
      v?.addEventListener("seeked", draw);
      v?.addEventListener("loadeddata", draw);
    }
    return () => {
      for (const v of els) {
        v?.removeEventListener("seeked", draw);
        v?.removeEventListener("loadeddata", draw);
      }
    };
  }, [cam?.file]);
  useEffect(draw, [project, editingZoom?.id, blocks, look]);
  // The display font loads lazily; draw again once it can be used on the canvas.
  useEffect(() => {
    if (blocks.length === 0) return;
    let on = true;
    void loadCaptionFont(captionStyle().family).then(() => on && draw());
    return () => {
      on = false;
    };
  }, [blocks.length > 0]);

  // Dev only: `window.__marzGrab(outUs)` pauses, seeks to output time `outUs`, draws and returns the
  // preview canvas as a PNG data URL (export checks compare it with the exported frame).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __marzGrab?: (outUs: number) => Promise<string> };
    w.__marzGrab = async (outUs) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) throw new Error("preview not ready");
      const store = useEditorStore.getState();
      store.pause();
      store.select(null);
      const seekedOf = (v: HTMLVideoElement | null) => (v ? new Promise<void>((r) => v.addEventListener("seeked", () => r(), { once: true })) : Promise.resolve());
      const seeked = Promise.all([seekedOf(video), seekedOf(live.current.project.tracks.camera ? camRef.current : null)]);
      store.seek(outputToSource(live.current.segs, outUs));
      await seeked;
      await new Promise((r) => requestAnimationFrame(r));
      draw();
      return canvas.toDataURL("image/png");
    };
    return () => {
      delete w.__marzGrab;
    };
  }, []);

  // Play / pause and the frame loop.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!playing) {
      video.pause();
      camRef.current?.pause();
      if (camRef.current) camRef.current.playbackRate = 1;
      for (const [audio] of audios()) audio.pause();
      return;
    }

    const start = startTimeForPlay(live.current.segs, useEditorStore.getState().playheadUs);
    if (start === null) {
      useEditorStore.getState().pause();
      return;
    }
    seekMedia(start);
    void video.play().catch(() => useEditorStore.getState().pause());
    for (const [audio] of audios()) void audio.play().catch(() => {});
    if (camRef.current && cam) void camRef.current.play().catch(() => {});

    let raf = 0;
    const loop = () => {
      const srcUs = sourceTimeUs(live.current.project, Math.round(video.currentTime * 1e6), firstFrame.current);
      if (playbackEnded(live.current.segs, srcUs, video.ended)) {
        useEditorStore.getState().pause();
        useEditorStore.getState().seek(live.current.project.durationUs);
        return;
      }
      const next = nextPlaybackTime(live.current.segs, srcUs) ?? srcUs;
      if (next !== srcUs) seekMedia(next);
      for (const [audio, track] of audios()) {
        const want = (next - track.offsetUs) / 1e6;
        if (want >= 0 && !audio.ended && audio.paused && !video.paused) void audio.play().catch(() => {});
        if (want >= 0 && !audio.ended && Math.abs(audio.currentTime - want) > AUDIO_DRIFT_S) audio.currentTime = want;
      }
      const cv = camRef.current;
      if (cv && live.current.project.tracks.camera) {
        const want = cameraTimeS(next);
        if (!cv.ended && cv.paused && !video.paused) void cv.play().catch(() => {});
        const gap = want - cv.currentTime;
        if (!cv.ended && Math.abs(gap) > CAMERA_SEEK_S) cv.currentTime = want;
        else cv.playbackRate = Math.abs(gap) <= CAMERA_LOCK_S ? 1 : gap > 0 ? 1.1 : 0.9;
      }
      useEditorStore.getState().tick(next);
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      video.pause();
      camRef.current?.pause();
      for (const [audio] of audios()) audio.pause();
    };
  }, [playing]);

  useEffect(() => {
    if (audioRef.current && mic) {
      audioRef.current.volume = Math.min(1, Math.max(0, mic.volume));
      audioRef.current.muted = mic.muted;
    }
  }, [mic?.volume, mic?.muted]);
  useEffect(() => {
    if (sysRef.current && sys) {
      sysRef.current.volume = Math.min(1, Math.max(0, sys.volume));
      sysRef.current.muted = sys.muted;
    }
  }, [sys?.volume, sys?.muted]);

  const selectedCut = selection?.kind === "cut" ? project.edits.cuts.find((c) => c.id === selection.id) : undefined;
  const caption = selectedZoom
    ? "Press Play to see the result"
    : selectedCut
      ? "This part is skipped when you export"
      : "Full frame. Select a zoom or cut on the timeline to edit it";

  return (
    <div className="pv-wrap" style={{ "--ar": `${project.output.width} / ${project.output.height}` } as React.CSSProperties}>
      <div className="pv-frame">
        <canvas ref={canvasRef} width={project.output.width} height={project.output.height} />
        {editingZoom && <ZoomOverlay key={editingZoom.id} zoom={editingZoom} />}
        {selectedCut && (
          <>
            <div className="pv-cut" data-testid="preview-cut" />
            <div className="pv-chip">
              Cut {mmss(selectedCut.startUs)} to {mmss(selectedCut.endUs)}. Removed from export
            </div>
          </>
        )}
      </div>
      <div className="pv-cap">{caption}</div>
      <video
        ref={videoRef}
        src={storage.fileUrl(project.tracks.screen.file)}
        muted
        playsInline
        preload="auto"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />
      {mic && <audio ref={audioRef} src={storage.fileUrl(mic.file)} preload="auto" />}
      {sys && <audio ref={sysRef} src={storage.fileUrl(sys.file)} preload="auto" />}
      {cam && (
        <video
          ref={camRef}
          src={storage.fileUrl(cam.file)}
          muted
          playsInline
          preload="auto"
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
      )}
    </div>
  );
}
