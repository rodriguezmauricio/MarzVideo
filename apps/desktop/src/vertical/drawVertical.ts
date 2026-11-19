import {
  cameraLayerFor,
  captionLayout,
  drawCaptions,
  drawFrame,
  frameAt,
  layoutAt,
  verticalCaptionArea,
  verticalFrameAt,
  VERTICAL_SIZE,
  type Box,
  type CaptionBlock,
  type CaptionLookOpts,
  type CaptionStyle,
  type DrawLayer,
  type Measure,
} from "@marz/compositor";
import { verticalEdits, type MarzEvent, type Project } from "@marz/format";
import { PRESETS } from "../export/presets";
import { aimPathFor } from "./aimPath";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Size = { width: number; height: number };

export type VerticalCaptions = { blocks: CaptionBlock[]; look: CaptionLookOpts; style: CaptionStyle; tOutUs: number; measure: Measure };

export type VerticalDrawOpts = {
  project: Project;
  events: MarzEvent[];
  srcUs: number;
  /** The screen frame (a video element or a decoded frame). */
  screen: CanvasImageSource;
  /** The camera frame and its size, or null (no camera, or not ready). */
  camera: { source: CanvasImageSource; size: Size } | null;
  /** paper, ink, accent and rec from tokens.css (camera border, click effects). */
  colors: Record<"paper" | "ink" | "accent" | "rec", string>;
  /** Live drawing strokes (screen coordinates), drawn through the same window as the screen. */
  drawings?: DrawLayer | null;
  captions: VerticalCaptions | null;
  /** "follow" or "fit"; the project's setting when left out. */
  framing?: "follow" | "fit";
  /** Picture pixels per source pixel (a proxy is smaller than the source). 1 when left out. */
  srcScale?: number;
};

/** Draw one 1080 x 1920 vertical frame on `ctx` (canvas of VERTICAL_SIZE). Follow the action: the aimed
 *  window, the camera in its slot, captions in the safe area. Fit with bars: the 16:9 picture
 *  letterboxed on ink, captions in the bars. Returns the window shown (normalized, null for Fit) for
 *  the Aim view. Shared by the preview and the export, so both draw the same picture. */
export function drawVertical(ctx: Ctx, o: VerticalDrawOpts): { crop: Box | null } {
  const out = VERTICAL_SIZE;
  const framing = o.framing ?? verticalEdits(o.project).framing;
  if (framing === "fit") {
    const rect = PRESETS.vertical.frameRect;
    const src = o.project.output;
    ctx.fillStyle = o.colors.ink;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.save();
    ctx.translate(rect.x, rect.y);
    ctx.scale(rect.w / src.width, rect.h / src.height);
    const lay = layoutAt(o.project, o.srcUs, src);
    const cam = o.camera && lay.camera ? cameraLayerFor(o.project, lay, src, o.camera.source, o.camera.size, o.colors) : null;
    drawFrame(ctx, o.screen, frameAt(o.project, o.events, o.srcUs, lay.screen), src, cam, o.colors, o.drawings ?? null, o.srcScale ?? 1);
    ctx.restore();
    if (o.captions) {
      const c = o.captions;
      const d = captionLayout(c.blocks, c.tOutUs, c.look, out, rect, c.measure);
      if (d) drawCaptions(ctx, d, c.style);
    }
    return { crop: null };
  }
  const { spec, layout, crop } = verticalFrameAt(o.project, o.events, aimPathFor(o.project, o.events), o.srcUs, out);
  const cam = o.camera && layout.camera ? cameraLayerFor(o.project, layout, out, o.camera.source, o.camera.size, o.colors) : null;
  drawFrame(ctx, o.screen, spec, out, cam, o.colors, o.drawings ?? null, o.srcScale ?? 1);
  if (o.captions) {
    const c = o.captions;
    const full = { x: 0, y: 0, w: out.width, h: out.height };
    const d = captionLayout(c.blocks, c.tOutUs, c.look, out, full, c.measure, verticalCaptionArea(layout, out));
    if (d) drawCaptions(ctx, d, c.style);
  }
  return { crop };
}
