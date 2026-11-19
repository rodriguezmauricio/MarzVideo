import { canvasMeasure, captionLayout, cameraLayout, cameraMediaUs, drawCaptions, drawFrame, frameAt, type CaptionBlock, type CaptionLook, type CaptionStyle } from "@marz/compositor";
import type { MarzEvent, Project } from "@marz/format";
import { keptSegments } from "@marz/timeline";
import { mediaTimeUs } from "../playback/clock";
import type { ProjectStorage } from "../storage/types";
import { createFrameSource } from "./frameSource";
import { outputFrameCount, outputFrameTimes, outputFrameUs, refuseEmpty } from "./outputFrames";
import { createChunkQueue } from "./chunkQueue";
import { pickEncoderConfig } from "./encoderConfig";
import type { ExportPreset } from "./presets";
import { buildExportJob, type ExportReport, type ExportSink } from "./sink";

const MAX_ENCODE_QUEUE = 8;
/** Chunks waiting for the sink before the encoder is held back (about half a second of video). */
const MAX_PENDING_WRITES = 16;

export interface ExportOptions {
  project: Project;
  events: MarzEvent[];
  storage: ProjectStorage;
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
  captions?: { blocks: CaptionBlock[]; look: CaptionLook; style: CaptionStyle } | null;
}

/** Ink behind the vertical letterbox, read from tokens.css so the colour lives in one place. */
function inkColor(): string {
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
  if (!ink) throw new Error("The --ink token is missing");
  return ink;
}

function abortError(): DOMException {
  return new DOMException("Export cancelled", "AbortError");
}

/** Composite every output frame with the preview's compositor, encode it with WebCodecs and stream the
 *  chunks to `sink`. Resolves with the sink's report; on failure or abort the sink is cancelled. */
export async function exportProject(opts: ExportOptions): Promise<ExportReport> {
  const { project, events, storage, sink, preset, signal, onProgress } = opts;
  const segs = keptSegments(project.durationUs, project.edits.cuts);
  const empty = refuseEmpty(segs);
  if (empty) throw new Error(empty);
  if (signal.aborted) throw abortError();

  const fps = preset.fps(project.source.fps);
  const total = outputFrameCount(segs, fps);
  const config = await pickEncoderConfig(preset, fps, async (c) => (await VideoEncoder.isConfigSupported(c)).supported === true);
  if (!config) throw new Error("This computer cannot encode H.264 video");

  // The editor frame (project.output), then the preset's picture with that frame placed at frameRect.
  const out = project.output;
  const rect = preset.frameRect;
  const direct = out.width === preset.width && out.height === preset.height && rect.x === 0 && rect.y === 0 && rect.w === preset.width && rect.h === preset.height;
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
  // The camera picture-in-picture, drawn by the same compositor as the preview (null: none or hidden).
  const camLayout = cameraLayout(project, out);
  let camSource: Awaited<ReturnType<typeof createFrameSource>> | null = null;
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
    if (camLayout && project.tracks.camera) camSource = await createFrameSource(storage.fileUrl(project.tracks.camera.file));
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
      const camFrame = camSource ? await camSource.frameAt(cameraMediaUs(project, srcUs) + camSource.firstFrameUs) : null;
      try {
        drawFrame(compCtx, frame, frameAt(project, events, srcUs), out, camFrame && camLayout ? { source: camFrame, ...camLayout } : null);
      } finally {
        frame.close();
        camFrame?.close();
      }
      if (!direct) {
        encCtx.fillStyle = ink;
        encCtx.fillRect(0, 0, preset.width, preset.height);
        encCtx.drawImage(compCanvas, rect.x, rect.y, rect.w, rect.h);
      }
      if (caps && measure) {
        const d = captionLayout(caps.blocks, outputFrameUs(k, fps), caps.look, { width: preset.width, height: preset.height }, capsFrame, measure);
        if (d) drawCaptions(encCtx, d, caps.style);
      }

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
    return await sink.finish();
  } catch (e) {
    if (encoder && encoder.state !== "closed") encoder.close();
    source?.close();
    camSource?.close();
    await writes.drain();
    await sink.cancel().catch(() => {});
    throw e;
  }
}
