import { useEffect, useMemo, useRef } from "react";
import { drawFrame, frameAt } from "@marz/compositor";
import { keptSegments, outputToSource } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { mediaTimeUs, nextPlaybackTime, playbackEnded, sourceTimeUs, startTimeForPlay } from "../playback/clock";
import { readFirstFrameUs } from "../playback/firstFrame";
import { mmss } from "./timecode";
import { ZoomOverlay } from "./ZoomOverlay";

const AUDIO_DRIFT_S = 0.04;

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

  // Latest values for the animation loop without restarting it.
  const live = useRef({ project, segs, editing: false });
  live.current = { project, segs, editing: !!editingZoom };

  const draw = () => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || video.readyState < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { project: p, editing } = live.current;
    const srcUs = sourceTimeUs(p, Math.round(video.currentTime * 1e6), firstFrame.current);
    const { events } = useEditorStore.getState();
    const shown = editing ? { ...p, edits: { ...p.edits, zooms: [] } } : p;
    drawFrame(ctx, video, frameAt(shown, events, srcUs), p.output);
  };

  const seekMedia = (srcUs: number) => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) video.currentTime = Math.max(0, mediaTimeUs(project, srcUs, firstFrame.current) / 1e6);
    for (const [audio, track] of audios()) audio.currentTime = Math.max(0, (srcUs - track.offsetUs) / 1e6);
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
    const video = videoRef.current;
    video?.addEventListener("seeked", draw);
    video?.addEventListener("loadeddata", draw);
    return () => {
      video?.removeEventListener("seeked", draw);
      video?.removeEventListener("loadeddata", draw);
    };
  }, []);
  useEffect(draw, [project, editingZoom?.id]);

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
      const seeked = new Promise<void>((r) => video.addEventListener("seeked", () => r(), { once: true }));
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
      useEditorStore.getState().tick(next);
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      video.pause();
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
    </div>
  );
}
