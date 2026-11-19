import type { MarzEvent, Project } from "@marz/format";
import { zoomRectAt } from "@marz/timeline";
import { clickEffectsAt, cursorAt, type ClickDraw, type CursorDraw } from "./cursor";

export type FrameSpec = {
  /** Visible part of the source frame, in source pixels. */
  srcRect: { sx: number; sy: number; sw: number; sh: number };
  /** Where the picture goes in the output, in output pixels. Letterboxed when the shown area's aspect differs from the output's. */
  dstRect: { dx: number; dy: number; dw: number; dh: number };
  /** The cursor (hotspot in output pixels, shape, scale), or null when not visible. */
  cursor: CursorDraw | null;
  /** Click effects to draw under the cursor. */
  clicks: ClickDraw[];
};

/** Fit a source area of size sw x sh inside the box without stretching it ("contain"). */
function containRect(sw: number, sh: number, box: { x: number; y: number; w: number; h: number }): FrameSpec["dstRect"] {
  const wider = sw * box.h >= sh * box.w; // source aspect >= box aspect
  const dw = wider ? box.w : (box.h * sw) / sh;
  const dh = wider ? (box.w * sh) / sw : box.h;
  return { dx: box.x + (box.w - dw) / 2, dy: box.y + (box.h - dh) / 2, dw, dh };
}

/** Everything needed to draw the frame for source time `srcUs`. Shared by preview and export.
 *  `screenBox` is where the screen goes on the output (the layout's screen box; the whole output by
 *  default). */
export function frameAt(project: Project, events: MarzEvent[], srcUs: number, screenBox?: { x: number; y: number; w: number; h: number }): FrameSpec {
  const { width: srcW, height: srcH } = project.source;
  const r = zoomRectAt(project.edits.zooms, srcUs);
  const srcRect = { sx: r.x * srcW, sy: r.y * srcH, sw: r.w * srcW, sh: r.h * srcH };

  const dstRect = containRect(srcRect.sw, srcRect.sh, screenBox ?? { x: 0, y: 0, w: project.output.width, h: project.output.height });

  const cursor = cursorAt(project, events, srcUs, srcRect, dstRect);
  const clicks = clickEffectsAt(project, events, srcUs, srcRect, dstRect);
  return { srcRect, dstRect, cursor, clicks };
}
