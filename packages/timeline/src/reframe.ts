import type { MarzEvent, Rect, VerticalHold, Zoom } from "@marz/format";
import { ease, zoomRectAt } from "./zoom";

/** Smart vertical: where the 9:16 window aims (its horizontal centre, a share of the screen width).
 *  Design: docs/superpowers/specs/2026-11-19-smart-vertical-design.md, "The aim". This is a path for
 *  the crop window; the cursor itself is never smoothed. */

export const AIM = {
  /** A rest: the cursor stays within REST_RADIUS (share of width and height) this long. */
  REST_US: 400_000,
  REST_RADIUS: 0.02,
  /** A point closer than this share of the window's half width to the aim does not move it. */
  DEAD_FRAC: 0.65,
  /** An eased move takes this long, never less than MIN_MOVE_US. */
  MOVE_US: 700_000,
  MIN_MOVE_US: 400_000,
  /** Shortest still time between two moves. */
  MIN_HOLD_US: 1_000_000,
  /** The cursor outside the window this long is followed, aiming to arrive this soon after it left. */
  EXCURSION_US: 1_000_000,
  EXCURSION_LEAD_US: 500_000,
  /** Frame blocks ease in and out over this long (half the block when it is shorter). */
  HOLD_EASE_US: 400_000,
  /** Grid used to watch the cursor for excursions. */
  STEP_US: 100_000,
} as const;

export type AimMove = { startUs: number; endUs: number; fromX: number; toX: number };
/** The automatic aim: the start and the eased moves, in time order, never overlapping. */
export type AimPath = { x0: number; moves: AimMove[] };

type Size = { width: number; height: number };
type Point = { tUs: number; x: number; y: number };
type Poi = { tUs: number; x: number; rank: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The full-height 9:16 window's width as a share of the screen width (at most the whole width). */
export function windowWidth(source: Size): number {
  return Math.min(1, (source.height * 9) / 16 / source.width);
}

/** Index of the last point with tUs <= t, or -1. */
function lastAt(points: Point[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.tUs <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Cursor rests: runs where the cursor stays within the radius of the run's first position for at
 *  least REST_US (until the next position outside it, or the end). Point at the run's start, mean x. */
function rests(cursor: Point[], durationUs: number): Poi[] {
  const out: Poi[] = [];
  let i = 0;
  while (i < cursor.length) {
    const a = cursor[i]!;
    let j = i + 1;
    let sum = a.x;
    while (j < cursor.length && Math.abs(cursor[j]!.x - a.x) <= AIM.REST_RADIUS && Math.abs(cursor[j]!.y - a.y) <= AIM.REST_RADIUS) {
      sum += cursor[j]!.x;
      j++;
    }
    const end = j < cursor.length ? cursor[j]!.tUs : durationUs;
    if (end - a.tUs >= AIM.REST_US) {
      out.push({ tUs: a.tUs, x: sum / (j - i), rank: 1 });
      i = j;
    } else i++;
  }
  return out;
}

const inside = (x: number, z: Rect) => x >= z.x && x <= z.x + z.w;

/** The automatic aim path for a take: points of interest (cursor rests, clicks, zoom starts, long
 *  excursions out of the window), a dead zone so the window holds still while the action stays in
 *  view, and eased moves that arrive when the action happens. While a zoom is on, only points inside
 *  the zoom area count. */
export function autoAim(events: MarzEvent[], source: Size, durationUs: number, zooms: Zoom[]): AimPath {
  const nx = (x: number) => x / source.width;
  const ny = (y: number) => y / source.height;
  const cursor: Point[] = [];
  const pois: Poi[] = [];
  for (const e of events) {
    if (e.tUs < 0 || e.tUs > durationUs) continue;
    if (e.type === "cursor") cursor.push({ tUs: e.tUs, x: nx(e.x), y: ny(e.y) });
    else if (e.type === "click" && e.state === "down") pois.push({ tUs: e.tUs, x: nx(e.x), rank: 0 });
  }
  cursor.sort((a, b) => a.tUs - b.tUs);
  pois.push(...rests(cursor, durationUs));
  for (const z of zooms) if (z.endUs > z.startUs) pois.push({ tUs: z.startUs, x: z.rect.x + z.rect.w / 2, rank: 0 });
  // Same time: clicks and zooms before rests.
  pois.sort((a, b) => a.tUs - b.tUs || a.rank - b.rank);

  const refW = windowWidth(source);
  /** The window's half width and the area it must stay in at time t (the zoom's, the screen without one). */
  const frameAt = (t: number) => {
    const z = zoomRectAt(zooms, t);
    return { hw: (refW * z.h) / 2, z };
  };
  const target = (x: number, t: number) => {
    const { hw, z } = frameAt(t);
    const lo = z.x + hw;
    const hi = z.x + z.w - hw;
    return lo > hi ? z.x + z.w / 2 : clamp(x, lo, hi);
  };

  const first = pois[0] ?? (cursor[0] ? { tUs: cursor[0].tUs, x: cursor[0].x, rank: 1 } : null);
  const x0 = first ? target(first.x, first.tUs) : 0.5;
  const moves: AimMove[] = [];
  let c = x0;
  let lastEnd = -Infinity;

  const consider = (tUs: number, x: number, notBefore = 0) => {
    const { hw, z } = frameAt(tUs);
    // A zoom is on: only what happens inside its area counts.
    if (z.w < 1 && !inside(x, z)) return;
    const to = target(x, tUs);
    if (Math.abs(to - c) <= hw * AIM.DEAD_FRAC && Math.abs(x - c) <= hw * AIM.DEAD_FRAC) return;
    if (Math.abs(to - c) < 1e-9) return;
    const start = Math.max(notBefore, tUs - AIM.MOVE_US, lastEnd + AIM.MIN_HOLD_US);
    const endUs = start + clamp(tUs - start, AIM.MIN_MOVE_US, AIM.MOVE_US);
    moves.push({ startUs: start, endUs, fromX: c, toX: to });
    c = to;
    lastEnd = endUs;
  };

  // Walk time on a grid: points of interest as they come, and the cursor staying out of the window.
  let p = 0;
  let outSince: number | null = null;
  let outSum = 0;
  let outN = 0;
  for (let t = 0; t <= durationUs + AIM.STEP_US; t += AIM.STEP_US) {
    while (p < pois.length && pois[p]!.tUs <= t) {
      consider(pois[p]!.tUs, pois[p]!.x);
      p++;
    }
    const i = lastAt(cursor, t);
    if (i < 0 || t > durationUs) continue;
    const x = cursor[i]!.x;
    const { hw, z } = frameAt(t);
    const outOfView = Math.abs(x - c) > hw && (z.w >= 1 || inside(x, z));
    if (!outOfView) {
      outSince = null;
      continue;
    }
    if (outSince === null) {
      outSince = t;
      outSum = 0;
      outN = 0;
    }
    outSum += x;
    outN++;
    if (t - outSince >= AIM.EXCURSION_US) {
      // Not before the cursor left the window: an excursion is followed, never anticipated.
      consider(outSince + AIM.EXCURSION_LEAD_US, outSum / outN, outSince);
      outSince = null;
    }
  }
  return { x0, moves };
}

/** The automatic aim at source time t. */
export function aimPathAt(path: AimPath, tUs: number): number {
  let x = path.x0;
  for (const m of path.moves) {
    if (m.startUs > tUs) break;
    if (tUs >= m.endUs) {
      x = m.toX;
      continue;
    }
    return m.fromX + (m.toX - m.fromX) * ease("easeInOutCubic", (tUs - m.startUs) / (m.endUs - m.startUs));
  }
  return x;
}

/** The aim at t with his Frame blocks: inside a block its x wins, eased in and out. */
export function aimAt(path: AimPath, holds: VerticalHold[], tUs: number): number {
  const auto = aimPathAt(path, tUs);
  let hold: VerticalHold | undefined;
  for (const h of holds) if (tUs >= h.startUs && tUs < h.endUs && (!hold || h.startUs >= hold.startUs)) hold = h;
  if (!hold) return auto;
  const e = Math.min(AIM.HOLD_EASE_US, (hold.endUs - hold.startUs) / 2);
  const w = e <= 0 ? 1 : Math.min(1, (tUs - hold.startUs) / e, (hold.endUs - tUs) / e);
  const k = ease("easeInOutCubic", w);
  return auto + (hold.x - auto) * k;
}

/** The part of the screen (normalized) shown in a box of aspect `boxAspect` (width / height): the zoom's
 *  height (its top), as wide as the box asks, centred on the aim and kept inside the zoom area. A box
 *  wider than the zoom takes the zoom's width instead, centred on the zoom's middle. */
export function cropRectAt(aimX: number, zoom: Rect, source: Size, boxAspect: number): Rect {
  let h = zoom.h;
  let w = (h * source.height * boxAspect) / source.width;
  if (w > zoom.w) {
    w = zoom.w;
    h = (w * source.width) / boxAspect / source.height;
  }
  const x = clamp(aimX - w / 2, zoom.x, zoom.x + zoom.w - w);
  return { x, y: zoom.y + (zoom.h - h) / 2, w, h };
}
