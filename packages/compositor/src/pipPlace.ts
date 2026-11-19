// Placing the corner bubble by hand on the preview (DESIGN-SYSTEM.md "Camera on the preview"):
// where a dragged bubble lands, and how a corner handle resizes it. Output pixels throughout.
import { PIP_CORNERS, type Corner, type Pip } from "@marz/format";
import type { Box } from "./camera";
import { BUBBLE_SQUARE_FRAC, bubbleBox, isSquareShape } from "./layout";

type Size = { width: number; height: number };

/** A bubble let go within this share of the output width of a corner's spot snaps into the corner. */
export const SNAP_FRAC = 0.04;
/** Bubble width limits while resizing, as shares of the output width. */
export const BUBBLE_MIN_FRAC = 0.08;
export const BUBBLE_MAX_FRAC = 0.6;

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** The pip's `widthFrac` for a bubble box `w` wide (square shapes are a share of the bubble width). */
function widthFracFor(pip: Pip, w: number, out: Size): number {
  const unit = out.width * (isSquareShape(pip.shape) ? BUBBLE_SQUARE_FRAC : 1);
  // Same size as now (a plain move): keep the stored value instead of a rounded copy.
  if (Math.round(unit * pip.widthFrac) === Math.round(w)) return pip.widthFrac;
  return Math.min(1, round5(w / unit));
}

/** The pip after the bubble was let go at `box`: snapped into a corner when it is close to that
 *  corner's spot (no `x`, `y`), otherwise free at `box` with the nearest corner (the side column's side). */
export function dropPip(pip: Pip, box: Box, out: Size, cam: Size): Pip {
  const { x: _x, y: _y, ...rest } = pip;
  const sized: Pip = { ...rest, widthFrac: widthFracFor(pip, box.w, out) };
  const reach = SNAP_FRAC * out.width;
  let best: { corner: Corner; d: number } | null = null;
  for (const corner of PIP_CORNERS) {
    const spot = bubbleBox(out, cam, { ...sized, corner }).box;
    const d = Math.hypot(spot.x - box.x, spot.y - box.y);
    if (d <= reach && (!best || d < best.d)) best = { corner, d };
  }
  if (best) return { ...sized, corner: best.corner };
  const right = box.x + box.w / 2 >= out.width / 2;
  const bottom = box.y + box.h / 2 >= out.height / 2;
  const corner: Corner = bottom ? (right ? "bottomRight" : "bottomLeft") : right ? "topRight" : "topLeft";
  return { ...sized, corner, x: round5(Math.max(0, box.x) / out.width), y: round5(Math.max(0, box.y) / out.height) };
}

/** `box` resized from its `handle` corner towards `pointer`: the opposite corner stays, the aspect is
 *  kept, the width follows the pointer sideways, 8% to 60% of the output width and inside the frame. */
export function resizeBubble(box: Box, handle: "nw" | "ne" | "sw" | "se", pointer: { x: number; y: number }, out: Size): Box {
  const k = box.w > 0 ? box.h / box.w : 1;
  const west = handle.includes("w");
  const north = handle.includes("n");
  const ax = west ? box.x + box.w : box.x;
  const ay = north ? box.y + box.h : box.y;
  const availX = west ? ax : out.width - ax;
  const availY = (north ? ay : out.height - ay) / k;
  const max = Math.max(out.width * BUBBLE_MIN_FRAC, Math.min(out.width * BUBBLE_MAX_FRAC, availX, availY));
  const w = Math.min(max, Math.max(out.width * BUBBLE_MIN_FRAC, west ? ax - pointer.x : pointer.x - ax));
  const h = w * k;
  return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

/** The pip with the bubble at `box` exactly (free, no snapping): what the preview draws while dragging. */
export function pipAtBox(pip: Pip, box: Box, out: Size): Pip {
  return { ...pip, widthFrac: widthFracFor(pip, box.w, out), x: round5(Math.max(0, box.x) / out.width), y: round5(Math.max(0, box.y) / out.height) };
}
