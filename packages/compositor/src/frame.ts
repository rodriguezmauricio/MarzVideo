import type { MarzEvent, Project } from "@marz/format";
import { zoomRectAt } from "@marz/timeline";

export type FrameSpec = {
  /** Visible part of the source frame, in source pixels. */
  srcRect: { sx: number; sy: number; sw: number; sh: number };
  /** Where the picture goes in the output, in output pixels. Letterboxed when the shown area's aspect differs from the output's. */
  dstRect: { dx: number; dy: number; dw: number; dh: number };
  /** Cursor position in output pixels, or null when not visible. */
  cursor: { x: number; y: number } | null;
};

/** Fit a source area of size sw x sh inside the output without stretching it ("contain"). */
function containRect(sw: number, sh: number, out: { width: number; height: number }): FrameSpec["dstRect"] {
  const wider = sw * out.height >= sh * out.width; // source aspect >= output aspect
  const dw = wider ? out.width : (out.height * sw) / sh;
  const dh = wider ? (out.width * sh) / sw : out.height;
  return { dx: (out.width - dw) / 2, dy: (out.height - dh) / 2, dw, dh };
}

/** Index of the last event with tUs <= t, or -1. Events must be sorted by tUs. */
function lastAtOrBefore(events: MarzEvent[], tUs: number): number {
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.tUs <= tUs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Everything needed to draw the frame for source time `srcUs`. Shared by preview and export. */
export function frameAt(project: Project, events: MarzEvent[], srcUs: number): FrameSpec {
  const { width: srcW, height: srcH } = project.source;
  const r = zoomRectAt(project.edits.zooms, srcUs);
  const srcRect = { sx: r.x * srcW, sy: r.y * srcH, sw: r.w * srcW, sh: r.h * srcH };

  const dstRect = containRect(srcRect.sw, srcRect.sh, project.output);

  let cursor: FrameSpec["cursor"] = null;
  if (!project.edits.cursor.hidden) {
    for (let i = lastAtOrBefore(events, srcUs); i >= 0; i--) {
      const e = events[i]!;
      if (e.type !== "cursor") continue;
      const inside =
        e.x >= srcRect.sx && e.x <= srcRect.sx + srcRect.sw && e.y >= srcRect.sy && e.y <= srcRect.sy + srcRect.sh;
      if (inside) {
        cursor = {
          x: dstRect.dx + ((e.x - srcRect.sx) / srcRect.sw) * dstRect.dw,
          y: dstRect.dy + ((e.y - srcRect.sy) / srcRect.sh) * dstRect.dh,
        };
      }
      break;
    }
  }
  return { srcRect, dstRect, cursor };
}
