import { useEffect, useMemo, useRef } from "react";
import { drawFrame, frameAt } from "@marz/compositor";
import { keptSegments } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { nextPlaybackTime, playbackEnded, startTimeForPlay } from "../playback/clock";
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

  const segs = useMemo(() => keptSegments(project.durationUs, project.edits.cuts), [project.durationUs, project.edits.cuts]);
  const screenOffset = project.tracks.screen.offsetUs;
  const mic = project.tracks.mic;

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
    const srcUs = Math.round(video.currentTime * 1e6) + screenOffset;
    const { events } = useEditorStore.getState();
    const shown = editing ? { ...p, edits: { ...p.edits, zooms: [] } } : p;
    drawFrame(ctx, video, frameAt(shown, events, srcUs), p.output);
  };

  const seekMedia = (srcUs: number) => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) video.currentTime = Math.max(0, (srcUs - screenOffset) / 1e6);
    if (audio && mic) audio.currentTime = Math.max(0, (srcUs - mic.offsetUs) / 1e6);
  };

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

  // Play / pause and the frame loop.
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;
    if (!playing) {
      video.pause();
      audio?.pause();
      return;
    }

    const start = startTimeForPlay(live.current.segs, useEditorStore.getState().playheadUs);
    if (start === null) {
      useEditorStore.getState().pause();
      return;
    }
    seekMedia(start);
    void video.play().catch(() => useEditorStore.getState().pause());
    if (audio && mic) void audio.play().catch(() => {});

    let raf = 0;
    const loop = () => {
      const srcUs = Math.round(video.currentTime * 1e6) + screenOffset;
      if (playbackEnded(live.current.segs, srcUs, video.ended)) {
        useEditorStore.getState().pause();
        useEditorStore.getState().seek(live.current.project.durationUs);
        return;
      }
      const next = nextPlaybackTime(live.current.segs, srcUs) ?? srcUs;
      if (next !== srcUs) seekMedia(next);
      if (audio && mic) {
        const want = (next - mic.offsetUs) / 1e6;
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
      audio?.pause();
    };
  }, [playing]);

  useEffect(() => {
    if (audioRef.current && mic) {
      audioRef.current.volume = Math.min(1, Math.max(0, mic.volume));
      audioRef.current.muted = mic.muted;
    }
  }, [mic?.volume, mic?.muted]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
      <div
        className="relative"
        style={{ aspectRatio: `${project.output.width} / ${project.output.height}`, maxHeight: "100%", maxWidth: "100%" }}
      >
        <canvas
          ref={canvasRef}
          width={project.output.width}
          height={project.output.height}
          className="h-full w-full rounded-md shadow-lg"
        />
        {editingZoom && <ZoomOverlay key={editingZoom.id} zoom={editingZoom} />}
      </div>
      <video
        ref={videoRef}
        src={storage.fileUrl(project.tracks.screen.file)}
        muted
        playsInline
        preload="auto"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />
      {mic && <audio ref={audioRef} src={storage.fileUrl(mic.file)} preload="auto" />}
    </div>
  );
}
