import type { Rect, Zoom } from "@marz/format";

export const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 };
export const MIN_RECT_SIZE = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function ease(name: Zoom["easing"], p: number): number {
  const t = clamp(p, 0, 1);
  if (name === "linear") return t;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const lerpRect = (a: Rect, b: Rect, p: number): Rect => ({
  x: a.x + (b.x - a.x) * p,
  y: a.y + (b.y - a.y) * p,
  w: a.w + (b.w - a.w) * p,
  h: a.h + (b.h - a.h) * p,
});

/** The visible source rect (normalized) at source time tUs. Later-starting zooms win overlaps. */
export function zoomRectAt(zooms: Zoom[], tUs: number): Rect {
  let active: Zoom | undefined;
  for (const z of zooms) {
    if (z.endUs <= z.startUs) continue;
    if (tUs < z.startUs || tUs >= z.endUs) continue;
    if (!active || z.startUs >= active.startUs) active = z;
  }
  if (!active) return FULL_RECT;

  const rect = clampRect(active.rect);
  const pIn = active.easeInUs > 0 ? (tUs - active.startUs) / active.easeInUs : 1;
  const pOut = active.easeOutUs > 0 ? (active.endUs - tUs) / active.easeOutUs : 1;
  const p = ease(active.easing, Math.min(1, pIn, pOut));
  return p >= 1 ? rect : lerpRect(FULL_RECT, rect, p);
}

export function clampRect(r: Rect): Rect {
  const w = clamp(r.w, MIN_RECT_SIZE, 1);
  const h = clamp(r.h, MIN_RECT_SIZE, 1);
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
}

/** Make the rect's pixel aspect equal `aspect`, keeping its center, inside the unit square. */
export function lockAspect(r: Rect, aspect: number, source: { width: number; height: number }): Rect {
  const k = source.width / (aspect * source.height); // h = w * k
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  let w = Math.max(r.w, MIN_RECT_SIZE);
  let h = w * k;
  if (h > 1) {
    h = 1;
    w = h / k;
  }
  if (w > 1) {
    w = 1;
    h = k;
  }
  if (h < MIN_RECT_SIZE) {
    h = MIN_RECT_SIZE;
    w = h / k;
  }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}
