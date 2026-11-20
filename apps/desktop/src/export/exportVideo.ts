import { canvasMeasure, captionLayout, cameraLayerFor, cameraMediaUs, drawCaptions, drawFrame, frameAt, layoutAt, strokesAt, verticalLayoutAt, type CaptionBlock, type CaptionLookOpts, type CaptionStyle } from "@marz/compositor";
import { drawKeysAt, loadKeysFont } from "../keys/keysDraw";
import { cameraEdits, drawingStrokes, keyItems, verticalEdits, type MarzEvent, type Project } from "@marz/format";
import { drawVertical } from "../vertical/drawVertical";
import { keptSegments } from "@marz/timeline";
import { mediaTimeUs } from "../playback/clock";
import { tokenColors } from "../components/cameraColors";
import { loadDrawingFont, strokeFamily } from "../drawing/drawingFont";
import type { ProjectStorage } from "../storage/types";
import { createFrameSource } from "./frameSource";
import { outputFrameCount, outputFrameTimes, outputFrameUs, refuseEmpty } from "./outputFrames";
import { createChunkQueue } from "./chunkQueue";
import { pickCodecConfig } from "./encoderConfig";
import { withCodec } from "./choices";
import type { ExportPreset } from "./presets";
import { buildExportJob, type ExportReport, type ExportSink } from "./sink";

const MAX_ENCODE_QUEUE = 8;
/** Chunks waiting for the sink before the encoder is held back (about half a second of video). */
const MAX_PENDING_WRITES = 16;

export interface ExportOptions {
  project: Project;
  events: MarzEvent[];
  storage: ProjectStorage;
  /** The screen plays from its proxy (raw files removed). `drawFrame` scales the crop to the media size by itself. */
  proxies?: boolean;
  sink: ExportSink;
  preset: ExportPreset;
  /** The project folder, passed to the muxer job (FFmpeg reads mic.wav from it). */
  projectDir: string;
  outPath: string;
  signal: AbortSignal;
  onProgress(p: number): void;
  /** Read the noise-cleaned mic copy (made just before the export). */
  cleanMic?: boolean;
  /** Captions to burn in (null: none). Output-time blocks, drawn after the frame. */
  captions?: { blocks: CaptionBlock[]; look: CaptionLookOpts; style: CaptionStyle } | null;
}

/** Ink behind the vertical letterbox, read from tokens.css so the colour lives in one place. */
function inkColor(): string {
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--brand-ink").trim();
  if (!ink) throw new Error("The --brand-ink token is missing");
  return ink;
}

function abortError(): DOMException {
  return new DOMException("Export cancelled", "AbortError");
}

/** Composite every output frame with the preview's compositor, encode it with WebCodecs and stream the
 *  chunks to `sink`. Resolves with the sink's report; on failure or abort the sink is cancelled. */
export async function exportProject(opts: ExportOptions): Promise<ExportReport> {
  const { project, events, storage, sink, signal, onProgress } = opts;
  const segs = keptSegments(project.durationUs, project.edits.cuts);
  const empty = refuseEmpty(segs);
  if (empty) throw new Error(empty);
  if (signal.aborted) throw abortError();

  const fps = opts.preset.fps(project.source.fps);
  const total = outputFrameCount(segs, fps);
  const picked = await pickCodecConfig(opts.preset, fps, async (c) => (await VideoEncoder.isConfigSupported(c)).supported === true);
  if (!picked) throw new Error("This computer cannot encode H.264 video");
  const { config, codec } = picked;
  if (codec !== opts.preset.codec) console.warn("[export] HEVC is not available here; encoding H.264");
  const preset = withCodec(opts.preset, codec);

  // The editor frame, then the preset's picture with that frame placed at frameRect. A landscape preset
  // of the editor frame's shape (720p, 1080p, 1440p) is composited straight at its own size.
  const rect = preset.frameRect;
  const fullRect = rect.x === 0 && rect.y === 0 && rect.w === preset.width && rect.h === preset.height;
  const sameShape = Math.abs(project.output.width * preset.height - project.output.height * preset.width) <= preset.width;
  const out = fullRect && sameShape ? { width: preset.width, height: preset.height } : project.output;
  // Smart vertical, Follow the action: the vertical picture is drawn straight on the encoder canvas.
  const follow = preset.id === "vertical" && verticalEdits(project).framing === "follow";
  const direct = follow || out.width === preset.width && out.height === preset.height && rect.x === 0 && rect.y === 0 && rect.w === preset.width && rect.h === preset.height;
  const encCanvas = new OffscreenCanvas(preset.width, preset.height);
  const encCtx = encCanvas.getContext("2d", { alpha: false })!;
  const compCanvas = direct ? encCanvas : new OffscreenCanvas(out.width, out.height);
  const compCtx = direct ? encCtx : compCanvas.getContext("2d", { alpha: false })!;
  const ink = inkColor();
  encCtx.imageSmoothingQuality = "high";
  const caps = opts.captions && opts.captions.blocks.length ? opts.captions : null;
  const measure = caps ? canvasMeasure(encCtx, caps.style.family) : null;
  const capsFrame = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };

  let source: Awaited<ReturnType<typeof createFrameSource>> | null = null;
  // The camera and its layouts, drawn by the same compositor as the preview.
  const colors = tokenColors();
  const camShown = !!project.tracks.camera && cameraEdits(project).visible;
  let camSource: Awaited<ReturnType<typeof createFrameSource>> | null = null;
  // Live drawing strokes, drawn by the same compositor call as the preview (after the screen).
  const hasStrokes = drawingStrokes(project).length > 0;
  const family = strokeFamily();
  if (drawingStrokes(project).some((s) => s.tool === "text")) await loadDrawingFont();
  if (keyItems(project).length > 0) await loadKeysFont();
  let encoder: VideoEncoder | null = null;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const writes = createChunkQueue((data) => sink.chunk(data), {
    max: MAX_PENDING_WRITES,
    stopped: () => failure !== null || signal.aborted,
    onError: (e) => {
      failure ??= e;
      poke();
    },
  });

  try {
    source = await createFrameSource(storage.fileUrl(project.tracks.screen.file));
    if (camShown && project.tracks.camera) camSource = await createFrameSource(storage.fileUrl(project.tracks.camera.file));
    await sink.begin(buildExportJob({ project, preset, projectDir: opts.projectDir, outPath: opts.outPath, cleanMic: opts.cleanMic }));

    encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        // Chunks arrive in decode order; the queue keeps them in that order at the sink.
        writes.push(data);
      },
      error: (e) => {
        failure ??= e instanceof Error ? e : new Error(String(e));
        poke();
      },
    });
    encoder.addEventListener("dequeue", poke);
    encoder.configure(config);

    const gop = Math.max(1, Math.round(fps * preset.keyframeEverySec));
    const frameDurUs = Math.round(1e6 / fps);
    let k = 0;
    for (const srcUs of outputFrameTimes(segs, fps)) {
      if (signal.aborted) throw abortError();
      if (failure) throw failure;

      const frame = await source.frameAt(mediaTimeUs(project, srcUs, source.firstFrameUs));
      if (follow) {
        const vlay = verticalLayoutAt(project, srcUs);
        const camFrame = camSource && vlay.camera ? await camSource.frameAt(cameraMediaUs(project, srcUs) + camSource.firstFrameUs) : null;
        try {
          const camera = camFrame ? { source: camFrame, size: { width: camFrame.displayWidth, height: camFrame.displayHeight } } : null;
          const vcaps = caps && measure ? { ...caps, tOutUs: outputFrameUs(k, fps), measure } : null;
          const drawings = hasStrokes ? { items: strokesAt(project, srcUs), colors, family } : null;
          drawVertical(encCtx, { project, events, srcUs, screen: frame, camera, colors, captions: vcaps, drawings, framing: "follow" });
        } finally {
          frame.close();
          camFrame?.close();
        }
      }
      const lay = follow ? null : layoutAt(project, srcUs, out);
      if (lay) {
        const camFrame = camSource && lay.camera ? await camSource.frameAt(cameraMediaUs(project, srcUs) + camSource.firstFrameUs) : null;
        try {
          const camera = camFrame ? cameraLayerFor(project, lay, out, camFrame, { width: camFrame.displayWidth, height: camFrame.displayHeight }, colors) : null;
          const drawings = hasStrokes ? { items: strokesAt(project, srcUs), colors, family } : null;
          drawFrame(compCtx, frame, frameAt(project, events, srcUs, lay.screen, { out }), out, camera, colors, drawings);
        } finally {
          frame.close();
          camFrame?.close();
        }
      }
      if (!direct) {
        encCtx.fillStyle = ink;
        encCtx.fillRect(0, 0, preset.width, preset.height);
        encCtx.drawImage(compCanvas, rect.x, rect.y, rect.w, rect.h);
      }
      if (caps && measure && !follow) {
        const d = captionLayout(caps.blocks, outputFrameUs(k, fps), caps.look, { width: preset.width, height: preset.height }, capsFrame, measure);
        if (d) drawCaptions(encCtx, d, caps.style);
      }
      // Logged shortcuts over the whole preset picture (the vertical Follow picture draws its own).
      if (!follow) drawKeysAt(encCtx, project, srcUs, { width: preset.width, height: preset.height }, preset.id === "vertical");

      while (encoder.encodeQueueSize >= MAX_ENCODE_QUEUE && !failure) await new Promise<void>((r) => (wake = r));
      await writes.room();
      if (signal.aborted) throw abortError();
      if (failure) throw failure;
      const vf = new VideoFrame(encCanvas, { timestamp: outputFrameUs(k, fps), duration: frameDurUs });
      try {
        encoder.encode(vf, { keyFrame: k % gop === 0 });
      } finally {
        vf.close();
      }
      k++;
      onProgress(k / total);
    }

    await encoder.flush();
    encoder.close();
    encoder = null;
    await writes.drain();
    if (failure) throw failure;
    source.close();
    source = null;
    camSource?.close();
    camSource = null;
    return { ...(await sink.finish()), codec };
  } catch (e) {
    if (encoder && encoder.state !== "closed") encoder.close();
    source?.close();
    camSource?.close();
    await writes.drain();
    await sink.cancel().catch(() => {});
    throw e;
  }
}
