import { useEffect, useMemo, useRef } from "react";
import { canvasMeasure, captionLayout, cameraLayerFor, cameraMediaUs, drawCaptions, drawFrame, frameAt, layoutAt, strokesAt, type CaptionStyle, type VisibleStroke } from "@marz/compositor";
import { keptSegments, outputDurationUs, outputToSource, sourceToOutput, strokeAtPoint, trackGain } from "@marz/timeline";
import { audioEdits, captionStyleFor, drawingStrokes, type Project } from "@marz/format";
import { addHold, updateHold } from "@marz/timeline";
import { VERTICAL_SIZE, type Box } from "@marz/compositor";
import { drawVertical } from "../vertical/drawVertical";
import { aimFrameAt, HOLD_LEN_US } from "../vertical/verticalActions";
import { ensureCleanMic, previewMicFile, useCleanMic } from "../audio/cleanMic";
import { useAppStore } from "../state/appStore";
import { captionBlocks, captionStyle, loadCaptionFont } from "../ai/captionStyle";
import { useEditorStore } from "../state/editorStore";
import { audioStep, mediaTimeUs, nextPlaybackTime, playbackEnded, sourceTimeUs, startTimeForPlay } from "../playback/clock";
import { readFirstFrameUs } from "../playback/firstFrame";
import { screenErrorText } from "../playback/screenError";
import { mmss } from "./timecode";
import { tokenColors } from "./cameraColors";
import { ZoomOverlay } from "./ZoomOverlay";
import { DrawingOverlay, useStrokeDraft } from "../drawing/DrawingOverlay";
import { loadDrawingFont, measureStrokeText, strokeFamily } from "../drawing/drawingFont";

/** The strokes to draw at `srcUs`: the dragged draft instead of its stored stroke, and the selected
 *  stroke at full opacity while it is being edited (paused), even outside its time. */
function visibleStrokes(p: Project, srcUs: number, editId: string | null): VisibleStroke[] {
  const draft = useStrokeDraft.getState().draft;
  let items = strokesAt(p, srcUs).filter((v) => v.stroke.id !== editId);
  const edited = editId ? drawingStrokes(p).find((s) => s.id === editId) : undefined;
  if (edited) items = [...items, { stroke: draft?.id === edited.id ? draft : edited, alpha: 1 }];
  return items;
}

/** Click tolerance on the preview, in output pixels. */
const HIT_PX = 8;

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
  const selectedStroke = selection?.kind === "drawing" ? drawingStrokes(project).find((s) => s.id === selection.id) : undefined;
  const editingStroke = selectedStroke && !playing ? selectedStroke : undefined;
  const hasStrokes = drawingStrokes(project).length > 0;

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

  // Noise removal: the app makes a cleaned mic copy and the preview plays it once it is ready.
  const dir = useAppStore((s) => s.dir);
  const audio = audioEdits(project);
  const clean = useCleanMic((s) => s.state);
  const micFile = mic ? previewMicFile(clean, dir, mic.file, audio.denoise) : null;
  useEffect(() => {
    if (dir && mic && audio.denoise) void ensureCleanMic(dir, mic.file);
  }, [dir, mic?.file, audio.denoise]);

  /** Volume, mute and fades of each track at source time `srcUs` (output time for the fades), the
   *  same envelope the export's `afade` applies. The element volume caps at 100%. */
  const applyGains = (srcUs: number) => {
    const { project: p, segs: sg } = live.current;
    const a = audioEdits(p);
    const tOut = sourceToOutput(sg, srcUs) ?? 0;
    const dur = outputDurationUs(sg);
    const pairs: [HTMLAudioElement | null, AudioTrack | undefined, typeof a.mic][] = [
      [audioRef.current, p.tracks.mic, a.mic],
      [sysRef.current, p.tracks.system, a.system],
    ];
    for (const [el, t, fade] of pairs) {
      if (!el || !t) continue;
      el.muted = t.muted;
      const g = Math.min(1, Math.max(0, trackGain(t.volume, t.muted, fade, tOut, dur)));
      if (Math.abs(el.volume - g) > 0.001) el.volume = g;
    }
  };

  const words = useEditorStore((s) => s.words);
  const vertical = useEditorStore((s) => s.verticalPreview);
  // The vertical preview always shows the vertical preset's caption style.
  const preset = useEditorStore((s) => (s.verticalPreview ? "vertical" : s.captionPreset));
  const look = useMemo(() => captionStyleFor(project, preset), [project, preset]);
  const aimCanvasRef = useRef<HTMLCanvasElement>(null);
  const aimBoxRef = useRef<HTMLDivElement>(null);
  /** The window shown last (normalized), and the aim being dragged in the Aim view. */
  const lastCrop = useRef<Box | null>(null);
  const aimDraft = useRef<number | null>(null);
  const blocks = useMemo(() => captionBlocks(project, words, look), [project, words, look]);
  const style = useRef<CaptionStyle | null>(null);

  // Latest values for the animation loop without restarting it.
  const live = useRef({ project, segs, editing: false, blocks, look, vertical, strokeId: null as string | null });
  live.current = { project, segs, editing: !!editingZoom && !vertical, blocks, look, vertical, strokeId: editingStroke?.id ?? null };

  /** The project as the vertical preview shows it: with the aim being dragged applied. */
  const shownVertical = (p: Project): Project => {
    const x = aimDraft.current;
    if (x === null) return p;
    const sel = useEditorStore.getState().selection;
    if (sel?.kind === "frame") return updateHold(sel.id, { x })(p);
    const at = useEditorStore.getState().playheadUs;
    return addHold({ id: "aim-draft", startUs: at, endUs: at + HOLD_LEN_US, x })(p);
  };

  /** The vertical frame, then the Aim view (the whole screen, the window drawn on it). */
  const drawVerticalFrame = (ctx: CanvasRenderingContext2D, video: HTMLVideoElement, srcUs: number) => {
    const { project: p0, blocks: bl, look: lk, segs: sg, strokeId } = live.current;
    const p = shownVertical(p0);
    const { events } = useEditorStore.getState();
    const camVideo = camRef.current;
    const tOut = bl.length ? sourceToOutput(sg, srcUs) : null;
    let captions = null;
    if (tOut !== null) {
      style.current ??= captionStyle();
      captions = { blocks: bl, look: lk, style: style.current, tOutUs: tOut, measure: canvasMeasure(ctx, style.current.family) };
    }
    const camera = camVideo && camVideo.readyState >= 2 ? { source: camVideo, size: { width: camVideo.videoWidth, height: camVideo.videoHeight } } : null;
    const drawings = { items: visibleStrokes(p, srcUs, strokeId), colors: tokenColors(), family: strokeFamily() };
    const { crop } = drawVertical(ctx, { project: p, events, srcUs, screen: video, camera, colors: tokenColors(), captions, drawings });
    lastCrop.current = crop;
    const aim = aimCanvasRef.current;
    const actx = aim?.getContext("2d");
    if (aim && actx) actx.drawImage(video, 0, 0, aim.width, aim.height);
    const box = aimBoxRef.current;
    if (box) {
      box.style.display = crop ? "block" : "none";
      if (crop) {
        box.style.left = `${crop.x * 100}%`;
        box.style.top = `${crop.y * 100}%`;
        box.style.width = `${crop.w * 100}%`;
        box.style.height = `${crop.h * 100}%`;
        box.setAttribute("aria-valuenow", String(Math.round((crop.x + crop.w / 2) * 100)));
      }
    }
  };

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
    if (live.current.vertical) {
      try {
        drawVerticalFrame(ctx, video, srcUs);
      } catch (e) {
        console.warn("vertical frame not drawn", e);
      }
      return;
    }
    const { events } = useEditorStore.getState();
    // While a zoom is edited the background is left out too, so the zoom area maps to the whole frame.
    const shown = editing ? { ...p, edits: { ...p.edits, zooms: [], background: undefined } } : p;
    // While a zoom is edited the frame is the screen alone, so the zoom area overlay lines up.
    const lay = editing ? null : layoutAt(p, srcUs, p.output);
    const camVideo = camRef.current;
    const camera =
      lay && camVideo && camVideo.readyState >= 2
        ? cameraLayerFor(p, lay, p.output, camVideo, { width: camVideo.videoWidth, height: camVideo.videoHeight }, tokenColors())
        : null;
    const { strokeId } = live.current;
    const drawings = editing ? null : { items: visibleStrokes(p, srcUs, strokeId), colors: tokenColors(), family: strokeFamily() };
    drawFrame(ctx, video, frameAt(shown, events, srcUs, lay?.screen), p.output, camera, tokenColors(), drawings);
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
  useEffect(draw, [project, editingZoom?.id, editingStroke?.id, blocks, look, vertical]);
  // A stroke dragged on the preview is drawn where it is going.
  useEffect(() => useStrokeDraft.subscribe(() => draw()), []);
  // Text strokes use the display font; draw again once it loaded.
  useEffect(() => {
    if (!drawingStrokes(project).some((s) => s.tool === "text")) return;
    let on = true;
    void loadDrawingFont().then(() => on && draw());
    return () => {
      on = false;
    };
  }, [hasStrokes]);

  /** A click on the picture selects the topmost stroke under it (paused, no zoom being edited). */
  const strokeMeasure = useMemo(() => measureStrokeText(), []);
  const onFrameDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (playing || editingZoom || !hasStrokes || vertical) return;
    const r = e.currentTarget.getBoundingClientRect();
    const outX = ((e.clientX - r.left) / r.width) * project.output.width;
    const outY = ((e.clientY - r.top) / r.height) * project.output.height;
    const { events, playheadUs } = useEditorStore.getState();
    const spec = frameAt(project, events, playheadUs, layoutAt(project, playheadUs, project.output).screen);
    const k = spec.dstRect.dw / spec.srcRect.sw;
    const sx = spec.srcRect.sx + (outX - spec.dstRect.dx) / k;
    const sy = spec.srcRect.sy + (outY - spec.dstRect.dy) / (spec.dstRect.dh / spec.srcRect.sh);
    const shown = strokesAt(project, playheadUs).map((v) => v.stroke);
    const hit = strokeAtPoint(shown, sx, sy, HIT_PX / k, strokeMeasure);
    if (hit) useEditorStore.getState().select({ kind: "drawing", id: hit.id });
    else if (selection?.kind === "drawing") useEditorStore.getState().select(null);
  };
  const playheadUs = useEditorStore((s) => s.playheadUs);
  const events = useEditorStore((s) => s.events);
  const strokeMap = editingStroke && !vertical ? frameAt(project, events, playheadUs, layoutAt(project, playheadUs, project.output).screen) : null;
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
    // A track whose offset is still ahead waits; the loop starts it on time.
    for (const [audio, track] of audios()) if (start >= track.offsetUs) void audio.play().catch(() => {});
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
        const step = audioStep({ wantS: (next - track.offsetUs) / 1e6, currentS: audio.currentTime, paused: audio.paused, ended: audio.ended, videoPaused: video.paused });
        if (step.pause) audio.pause();
        if (step.seekS !== undefined) audio.currentTime = step.seekS;
        if (step.play) void audio.play().catch(() => {});
      }
      const cv = camRef.current;
      if (cv && live.current.project.tracks.camera) {
        const want = cameraTimeS(next);
        if (!cv.ended && cv.paused && !video.paused) void cv.play().catch(() => {});
        const gap = want - cv.currentTime;
        if (!cv.ended && Math.abs(gap) > CAMERA_SEEK_S) cv.currentTime = want;
        else cv.playbackRate = Math.abs(gap) <= CAMERA_LOCK_S ? 1 : gap > 0 ? 1.1 : 0.9;
      }
      applyGains(next);
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

  // Volume, mute and fades follow edits at once, also while paused; a new mic source (the cleaned copy)
  // lands where the playhead is.
  useEffect(() => applyGains(useEditorStore.getState().playheadUs), [project]);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !mic) return;
    const at = () => {
      el.currentTime = Math.max(0, (useEditorStore.getState().playheadUs - mic.offsetUs) / 1e6);
      applyGains(useEditorStore.getState().playheadUs);
    };
    el.addEventListener("loadedmetadata", at, { once: true });
    return () => el.removeEventListener("loadedmetadata", at);
  }, [micFile]);

  const selectedCut = selection?.kind === "cut" ? project.edits.cuts.find((c) => c.id === selection.id) : undefined;
  const selectedFrame = selection?.kind === "frame";
  /** Drag the window in the Aim view: the selected Frame block (or a new one at the playhead) follows. */
  const onAimDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const crop = lastCrop.current;
    const host = aimCanvasRef.current;
    if (!crop || !host) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    useEditorStore.getState().pause();
    const startX = e.clientX;
    const startAim = crop.x + crop.w / 2;
    const width = host.getBoundingClientRect().width;
    const el = e.currentTarget;
    const move = (ev: PointerEvent) => {
      aimDraft.current = Math.min(1, Math.max(0, startAim + (ev.clientX - startX) / Math.max(1, width)));
      draw();
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const x = aimDraft.current;
      aimDraft.current = null;
      if (x !== null) aimFrameAt(Math.round(x * 1000) / 1000);
      draw();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const caption = vertical
    ? selectedFrame
      ? "Drag the frame to aim this block"
      : "Vertical picture. Drag the frame to hold it here"
    : selectedZoom
    ? "Press Play to see the result"
    : selection?.kind === "layout"
      ? "Press Play to see the switch"
    : selectedStroke
      ? "Drag to move. Pull a corner to resize"
    : selectedCut
      ? "This part is skipped when you export"
      : "Full frame. Select a zoom or cut on the timeline to edit it";

  return (
    <div
      className={`pv-wrap${vertical ? " pv-vertical" : ""}`}
      style={{ "--ar": vertical ? `${VERTICAL_SIZE.width} / ${VERTICAL_SIZE.height}` : `${project.output.width} / ${project.output.height}` } as React.CSSProperties}
    >
      <div className="pv-row">
      <div className="pv-frame" data-testid="preview-frame">
        <canvas
          key={vertical ? "v" : "h"}
          ref={canvasRef}
          width={vertical ? VERTICAL_SIZE.width : project.output.width}
          height={vertical ? VERTICAL_SIZE.height : project.output.height}
          onPointerDown={onFrameDown}
        />
        {editingZoom && !vertical && <ZoomOverlay key={editingZoom.id} zoom={editingZoom} />}
        {editingStroke && strokeMap && <DrawingOverlay key={editingStroke.id} stroke={editingStroke} map={strokeMap} out={project.output} />}
        {selectedCut && (
          <>
            <div className="pv-cut" data-testid="preview-cut" />
            <div className="pv-chip">
              Cut {mmss(selectedCut.startUs)} to {mmss(selectedCut.endUs)}. Removed from export
            </div>
          </>
        )}
      </div>
      {vertical && (
        // The Aim view (DESIGN-SYSTEM.md "Vertical preview"): the whole screen with the 9:16 window on it.
        <div className="pv-aim" data-testid="aim-view" style={{ aspectRatio: `${project.source.width} / ${project.source.height}` }}>
          <canvas ref={aimCanvasRef} width={480} height={Math.round((480 * project.source.height) / project.source.width)} />
          <div
            ref={aimBoxRef}
            className="aim-box"
            data-testid="aim-box"
            onPointerDown={onAimDown}
            role="slider"
            aria-label="Vertical frame. Drag to aim"
            aria-valuemin={0}
            aria-valuemax={100}
          />
          <span className="aim-tag">Aim</span>
        </div>
      )}
      </div>
      <div className="pv-cap">{caption}</div>
      <video
        ref={videoRef}
        src={storage.fileUrl(project.tracks.screen.file)}
        muted
        playsInline
        preload="auto"
        onError={(e) => useEditorStore.setState({ warning: screenErrorText(e.currentTarget.error?.code) })}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />
      {mic && micFile && <audio ref={audioRef} src={storage.fileUrl(micFile)} preload="auto" data-testid="mic-audio" />}
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
