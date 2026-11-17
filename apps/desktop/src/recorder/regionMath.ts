// Region and zoom preset math for the recorder overlay. Pure functions; the overlay works in CSS
// pixels and converts to physical, monitor-relative pixels (what the engine records) at the edge.
import type { Rect as NormRect } from "@marz/format";
import { lockAspect } from "@marz/timeline";

export type { NormRect };
export type Pt = { x: number; y: number };
export type Size = { width: number; height: number };
/** A rectangle in pixels relative to the monitor's top-left corner. */
export type PxRect = { x: number; y: number; w: number; h: number };
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** The output aspect zoom presets are locked to. */
export const OUTPUT_ASPECT = 16 / 9;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampPt = (p: Pt, b: Size): Pt => ({ x: clamp(p.x, 0, b.width), y: clamp(p.y, 0, b.height) });

/** The rect between a drag's start and end, in any direction, inside `bounds`. With `aspect` the
 * rect keeps width / height = aspect, grows from `start` toward `end` and stays inside. */
export function dragRect(start: Pt, end: Pt, bounds: Size, aspect?: number): PxRect {
  const s = clampPt(start, bounds);
  const e = clampPt(end, bounds);
  if (!aspect) {
    return { x: Math.min(s.x, e.x), y: Math.min(s.y, e.y), w: Math.abs(e.x - s.x), h: Math.abs(e.y - s.y) };
  }
  const sx = e.x >= s.x ? 1 : -1;
  const sy = e.y >= s.y ? 1 : -1;
  const maxW = sx > 0 ? bounds.width - s.x : s.x;
  const maxH = sy > 0 ? bounds.height - s.y : s.y;
  const w = Math.min(Math.max(Math.abs(e.x - s.x), Math.abs(e.y - s.y) * aspect), maxW, maxH * aspect);
  const h = w / aspect;
  return { x: sx > 0 ? s.x : s.x - w, y: sy > 0 ? s.y : s.y - h, w, h };
}

const OPPOSITE: Record<"nw" | "ne" | "se" | "sw", (r: PxRect) => Pt> = {
  nw: (r) => ({ x: r.x + r.w, y: r.y + r.h }),
  ne: (r) => ({ x: r.x, y: r.y + r.h }),
  se: (r) => ({ x: r.x, y: r.y }),
  sw: (r) => ({ x: r.x + r.w, y: r.y }),
};

/** Drag `handle` of `rect` to `to`. Corners keep the opposite corner; edges keep the opposite edge
 * (and, with `aspect`, the centre on the other axis). Dragging past the opposite side flips. */
export function resizeRect(rect: PxRect, handle: Handle, to: Pt, bounds: Size, aspect?: number): PxRect {
  if (handle === "nw" || handle === "ne" || handle === "se" || handle === "sw") {
    return dragRect(OPPOSITE[handle](rect), to, bounds, aspect);
  }
  const p = clampPt(to, bounds);
  if (handle === "e" || handle === "w") {
    const fixed = handle === "e" ? rect.x : rect.x + rect.w;
    let w = Math.abs(p.x - fixed);
    const dir = p.x >= fixed ? 1 : -1;
    if (!aspect) return { x: dir > 0 ? fixed : fixed - w, y: rect.y, w, h: rect.h };
    let h = w / aspect;
    if (h > bounds.height) {
      h = bounds.height;
      w = h * aspect;
    }
    const cy = rect.y + rect.h / 2;
    return { x: dir > 0 ? fixed : fixed - w, y: clamp(cy - h / 2, 0, bounds.height - h), w, h };
  }
  const fixed = handle === "s" ? rect.y : rect.y + rect.h;
  let h = Math.abs(p.y - fixed);
  const dir = p.y >= fixed ? 1 : -1;
  if (!aspect) return { x: rect.x, y: dir > 0 ? fixed : fixed - h, w: rect.w, h };
  let w = h * aspect;
  if (w > bounds.width) {
    w = bounds.width;
    h = w / aspect;
  }
  const cx = rect.x + rect.w / 2;
  return { x: clamp(cx - w / 2, 0, bounds.width - w), y: dir > 0 ? fixed : fixed - h, w, h };
}

/** Move `rect` by (dx, dy), kept inside `bounds`. */
export function moveRect(rect: PxRect, dx: number, dy: number, bounds: Size): PxRect {
  return {
    ...rect,
    x: clamp(rect.x + dx, 0, Math.max(0, bounds.width - rect.w)),
    y: clamp(rect.y + dy, 0, Math.max(0, bounds.height - rect.h)),
  };
}

/** `rect` as fractions of `source` (0..1). */
export function toNorm(rect: PxRect, source: Size): NormRect {
  return { x: rect.x / source.width, y: rect.y / source.height, w: rect.w / source.width, h: rect.h / source.height };
}

export function fromNorm(n: NormRect, source: Size): PxRect {
  return { x: n.x * source.width, y: n.y * source.height, w: n.w * source.width, h: n.h * source.height };
}

const sizeOf = (r: PxRect): Size => ({ width: r.w, height: r.h });

/** A preset drawn by dragging from `start` to `end` (monitor pixels): kept inside `region`, locked
 * to the output aspect, stored normalized to the region. */
export function presetFromDrag(start: Pt, end: Pt, region: PxRect, aspect = OUTPUT_ASPECT): NormRect {
  const local = (p: Pt): Pt => ({ x: p.x - region.x, y: p.y - region.y });
  const r = dragRect(local(start), local(end), sizeOf(region), aspect);
  return lockAspect(toNorm(r, sizeOf(region)), aspect, sizeOf(region));
}

/** Where a stored preset is drawn (monitor pixels) for `region`, re-locked to the output aspect so a
 * region of another shape still gets a 16:9 preset. */
export function presetPx(n: NormRect, region: PxRect, aspect = OUTPUT_ASPECT): PxRect {
  const r = fromNorm(lockAspect(n, aspect, sizeOf(region)), sizeOf(region));
  return { x: r.x + region.x, y: r.y + region.y, w: r.w, h: r.h };
}

/** CSS pixels to whole physical pixels with the monitor's scale factor. */
export function toPhysical(r: PxRect, scale: number): PxRect {
  return { x: Math.round(r.x * scale), y: Math.round(r.y * scale), w: Math.round(r.w * scale), h: Math.round(r.h * scale) };
}

export function toCss(r: PxRect, scale: number): PxRect {
  return { x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale };
}

export const METER_BARS = 14;

/** Lit meter bars for a peak level 0..1, on a -60..0 dB scale. */
export function meterLit(level: number): number {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return clamp(Math.round(((db + 60) / 60) * METER_BARS), 0, METER_BARS);
}
