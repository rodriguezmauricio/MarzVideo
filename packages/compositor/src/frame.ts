import type { MarzEvent, Project } from "@marz/format";
import { zoomRectAt } from "@marz/timeline";
import { backgroundPx, framedBox, type BackgroundDraw } from "./background";
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
  /** The size `srcRect` is measured in (`project.source`). The drawn media may be smaller (a proxy):
   *  `drawFrame` scales the crop to the media's real pixel size. */
  sourceSize?: { width: number; height: number };
  /** The backdrop and the framed screen's box, when the project has a background (`edits.background`). */
  background?: BackgroundDraw;
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
 *  default). With a background the screen is framed inside that box, the margin away from its edges:
 *  the full picture at its own aspect, or the whole margin box with `opts.fill` (the vertical window,
 *  already cut to that box's aspect). Zooms happen inside the frame. `opts.out` is the output size
 *  (default `project.output`). */
export function frameAt(
  project: Project,
  events: MarzEvent[],
  srcUs: number,
  screenBox?: { x: number; y: number; w: number; h: number },
  opts?: { out?: { width: number; height: number }; fill?: boolean },
): FrameSpec {
  const { width: srcW, height: srcH } = project.source;
  const r = zoomRectAt(project.edits.zooms, srcUs);
  const srcRect = { sx: r.x * srcW, sy: r.y * srcH, sw: r.w * srcW, sh: r.h * srcH };
  const out = opts?.out ?? project.output;
  const box = screenBox ?? { x: 0, y: 0, w: out.width, h: out.height };

  const bg = backgroundPx(project, out);
  let background: BackgroundDraw | undefined;
  let into = box;
  if (bg) {
    const inner = framedBox(project, box, out);
    const f = opts?.fill ? null : containRect(srcW, srcH, inner);
    into = f ? { x: f.dx, y: f.dy, w: f.dw, h: f.dh } : inner;
    background = { style: bg.style, frame: into, radius: bg.radius, shadow: bg.shadow };
  }
  const dstRect = containRect(srcRect.sw, srcRect.sh, into);

  const cursor = cursorAt(project, events, srcUs, srcRect, dstRect);
  const clicks = clickEffectsAt(project, events, srcUs, srcRect, dstRect);
  const sourceSize = { width: srcW, height: srcH };
  return background ? { srcRect, dstRect, cursor, clicks, sourceSize, background } : { srcRect, dstRect, cursor, clicks, sourceSize };
}
