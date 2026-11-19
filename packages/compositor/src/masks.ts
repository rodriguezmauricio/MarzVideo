/** Camera mask outlines (camera extras design): polygons in the unit box as flat x, y pairs, y down.
 *  Used for the star, the imported SVG shape and shape morphs. */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Box = { x: number; y: number; w: number; h: number };

/** Points per outline when two shapes morph into each other. */
export const MORPH_POINTS = 96;
/** Most points an imported outline keeps. */
export const MAX_MASK_POINTS = 512;
/** Segments per curve when an SVG path is flattened. */
const CURVE_STEPS = 16;

/** Shoelace area; positive when the outline runs clockwise on screen (y down). */
export function polygonArea(pts: number[]): number {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[2 * i]! * pts[2 * j + 1]! - pts[2 * j]! * pts[2 * i + 1]!;
  }
  return a / 2;
}

function bounds(pts: number[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]!);
    x1 = Math.max(x1, pts[i]!);
    y0 = Math.min(y0, pts[i + 1]!);
    y1 = Math.max(y1, pts[i + 1]!);
  }
  return { x0, y0, x1, y1 };
}

/** Fit an outline into the unit box, aspect kept, centred. */
export function normalizeToUnit(pts: number[]): number[] {
  const b = bounds(pts);
  const s = Math.max(b.x1 - b.x0, b.y1 - b.y0);
  if (!(s > 0)) return pts.map(() => 0.5);
  const ox = (1 - (b.x1 - b.x0) / s) / 2;
  const oy = (1 - (b.y1 - b.y0) / s) / 2;
  return pts.map((v, i) => (i % 2 === 0 ? ox + (v - b.x0) / s : oy + (v - b.y0) / s));
}

/** A five-pointed star, inner radius half the outer, one point up, clockwise, fitted into the unit box. */
export function starPolygon(points = 5, inner = 0.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 1 : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    out.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return normalizeToUnit(out);
}

/** A `w` x `h` box with round corners of radius `r` (pixels) as a unit-box outline, clockwise. */
export function roundRectPolygon(w: number, h: number, r: number): number[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const rx = w > 0 ? rr / w : 0;
  const ry = h > 0 ? rr / h : 0;
  const corners: Array<[number, number, number]> = [
    [1 - rx, ry, -Math.PI / 2],
    [1 - rx, 1 - ry, 0],
    [rx, 1 - ry, Math.PI / 2],
    [rx, ry, Math.PI],
  ];
  const out: number[] = [];
  const steps = rr > 0 ? 8 : 0;
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (k / Math.max(1, steps)) * (Math.PI / 2);
      out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    }
  }
  return out;
}

/** `n` points evenly spread by length along the closed outline, starting at its top centre (the point
 *  nearest the middle of its bounding box's top edge), clockwise on screen. */
export function resamplePolygon(pts: number[], n: number): number[] {
  const k = pts.length / 2;
  if (k < 2) return Array.from({ length: n * 2 }, () => 0.5);
  let v: Array<[number, number]> = [];
  for (let i = 0; i < k; i++) v.push([pts[2 * i]!, pts[2 * i + 1]!]);
  if (polygonArea(pts) < 0) v = v.reverse();
  const b = bounds(pts);
  const tx = (b.x0 + b.x1) / 2;
  const ty = b.y0;
  // Nearest boundary point to the top centre.
  let best = { d: Infinity, seg: 0, t: 0 };
  for (let i = 0; i < k; i++) {
    const [ax, ay] = v[i]!;
    const [bx, by] = v[(i + 1) % k]!;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((tx - ax) * dx + (ty - ay) * dy) / len2)) : 0;
    const px = ax + t * dx - tx, py = ay + t * dy - ty;
    const d = px * px + py * py;
    if (d < best.d - 1e-12) best = { d, seg: i, t };
  }
  const [sx0, sy0] = v[best.seg]!;
  const [sx1, sy1] = v[(best.seg + 1) % k]!;
  const start: [number, number] = [sx0 + best.t * (sx1 - sx0), sy0 + best.t * (sy1 - sy0)];
  const ring: Array<[number, number]> = [start];
  for (let i = 1; i <= k; i++) ring.push(v[(best.seg + i) % k]!);
  ring.push(start);
  const cum = [0];
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1]! + Math.hypot(ring[i]![0] - ring[i - 1]![0], ring[i]![1] - ring[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const out: number[] = [];
  let j = 1;
  for (let i = 0; i < n; i++) {
    const at = (total * i) / n;
    while (j < ring.length - 1 && cum[j]! < at) j++;
    const seg = cum[j]! - cum[j - 1]!;
    const t = seg > 0 ? (at - cum[j - 1]!) / seg : 0;
    out.push(ring[j - 1]![0] + t * (ring[j]![0] - ring[j - 1]![0]), ring[j - 1]![1] + t * (ring[j]![1] - ring[j - 1]![1]));
  }
  return out;
}

/** Each point moves straight to its partner. Both outlines have the same number of points. */
export function lerpPolygon(a: number[], b: number[], p: number): number[] {
  if (p <= 0) return a;
  if (p >= 1) return b;
  return a.map((v, i) => v + ((b[i] ?? v) - v) * p);
}

/** The outline scaled into `box`, as the current path. */
export function maskPath(ctx: Ctx, pts: number[], box: Box): void {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const x = box.x + pts[i]! * box.w;
    const y = box.y + pts[i + 1]! * box.h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// ---- SVG import ---------------------------------------------------------------------------------

export type SvgMaskResult = { ok: true; points: number[] } | { ok: false; error: string };
const ONE_PATH = "Use an SVG with one closed path.";

/** Read one closed outline from SVG text: a single `path` (`d`) or `polygon` (`points`). The file is
 *  read as text, never rendered: nothing else in it is used or kept. */
export function parseSvgMask(text: string): SvgMaskResult {
  if (!/<svg[\s>]/i.test(text)) return { ok: false, error: ONE_PATH };
  const body = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<(defs|clipPath|mask|symbol|style|script)\b[\s\S]*?<\/\1\s*>/gi, "");
  const shapes = [...body.matchAll(/<(path|polygon|polyline|rect|circle|ellipse|line)\b([^>]*)>/gi)];
  if (shapes.length !== 1) return { ok: false, error: ONE_PATH };
  const [, tag, attrs] = shapes[0]!;
  const attr = (name: string) => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs ?? "");
    return m ? (m[1] ?? m[2] ?? "") : null;
  };
  let pts: number[] | null = null;
  if (tag!.toLowerCase() === "path") {
    const d = attr("d");
    pts = d ? flattenPath(d) : null;
  } else if (tag!.toLowerCase() === "polygon") {
    const nums = (attr("points") ?? "").match(NUM)?.map(Number) ?? [];
    pts = nums.length >= 6 && nums.length % 2 === 0 ? nums : null;
  }
  if (!pts) return { ok: false, error: ONE_PATH };
  pts = dedupe(pts);
  if (pts.length < 6 || pts.some((v) => !Number.isFinite(v))) return { ok: false, error: ONE_PATH };
  const unit = normalizeToUnit(pts);
  if (Math.abs(polygonArea(unit)) < 1e-4) return { ok: false, error: ONE_PATH };
  const kept = unit.length / 2 > MAX_MASK_POINTS ? resamplePolygon(unit, MAX_MASK_POINTS) : unit;
  return { ok: true, points: kept.map((v) => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000))) };
}

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** Drop repeated points and a last point equal to the first. */
function dedupe(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2]! - pts[i]!) < 1e-9 && Math.abs(out[n - 1]! - pts[i + 1]!) < 1e-9) continue;
    out.push(pts[i]!, pts[i + 1]!);
  }
  while (out.length >= 4 && Math.abs(out[0]! - out[out.length - 2]!) < 1e-9 && Math.abs(out[1]! - out[out.length - 1]!) < 1e-9) out.splice(-2, 2);
  return out;
}

/** Flatten an SVG path to one closed polygon (M L H V C S Q T A Z, absolute and relative). Null when
 *  it has more than one sub-path, is not closed, or cannot be read. */
export function flattenPath(d: string): number[] | null {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!tokens || !/^[Mm]$/.test(tokens[0]!)) return null;
  let i = 0;
  let cmd = "";
  let x = 0, y = 0, sx = 0, sy = 0;
  let lcx = 0, lcy = 0; // last control point (for S and T)
  let lastCmd = "";
  let closed = false;
  let subpaths = 0;
  const out: number[] = [];
  const isCmd = (t: string | undefined) => !!t && /^[A-Za-z]$/.test(t);
  const num = (): number => {
    const t = tokens[i++];
    if (t === undefined || isCmd(t)) throw new Error("number expected");
    return Number(t);
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      out.push(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      out.push(u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey);
    }
  };
  try {
    while (i < tokens.length) {
      if (isCmd(tokens[i])) cmd = tokens[i++]!;
      else if (!cmd) return null;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (closed && C !== "Z") return null; // a second sub-path after Z
      switch (C) {
        case "M": {
          if (subpaths > 0) return null;
          subpaths++;
          x = (rel ? x : 0) + num();
          y = (rel ? y : 0) + num();
          sx = x;
          sy = y;
          out.push(x, y);
          cmd = rel ? "l" : "L"; // extra pairs are lines
          break;
        }
        case "L":
          x = (rel ? x : 0) + num();
          y = (rel ? y : 0) + num();
          out.push(x, y);
          break;
        case "H":
          x = (rel ? x : 0) + num();
          out.push(x, y);
          break;
        case "V":
          y = (rel ? y : 0) + num();
          out.push(x, y);
          break;
        case "C": {
          const ox = rel ? x : 0, oy = rel ? y : 0;
          const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
          cubic(x1, y1, x2, y2, ex, ey);
          lcx = x2; lcy = y2; x = ex; y = ey;
          break;
        }
        case "S": {
          const ox = rel ? x : 0, oy = rel ? y : 0;
          const smooth = /[CcSs]/.test(lastCmd);
          const x1 = smooth ? 2 * x - lcx : x, y1 = smooth ? 2 * y - lcy : y;
          const x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
          cubic(x1, y1, x2, y2, ex, ey);
          lcx = x2; lcy = y2; x = ex; y = ey;
          break;
        }
        case "Q": {
          const ox = rel ? x : 0, oy = rel ? y : 0;
          const x1 = ox + num(), y1 = oy + num(), ex = ox + num(), ey = oy + num();
          quad(x1, y1, ex, ey);
          lcx = x1; lcy = y1; x = ex; y = ey;
          break;
        }
        case "T": {
          const ox = rel ? x : 0, oy = rel ? y : 0;
          const smooth = /[QqTt]/.test(lastCmd);
          const x1 = smooth ? 2 * x - lcx : x, y1 = smooth ? 2 * y - lcy : y;
          const ex = ox + num(), ey = oy + num();
          quad(x1, y1, ex, ey);
          lcx = x1; lcy = y1; x = ex; y = ey;
          break;
        }
        case "A": {
          const rx = Math.abs(num()), ry = Math.abs(num()), rot = num(), large = num() !== 0, sweep = num() !== 0;
          const ex = (rel ? x : 0) + num(), ey = (rel ? y : 0) + num();
          arc(out, x, y, rx, ry, rot, large, sweep, ex, ey);
          x = ex; y = ey;
          break;
        }
        case "Z":
          closed = true;
          x = sx;
          y = sy;
          break;
        default:
          return null;
      }
      lastCmd = cmd;
    }
  } catch {
    return null;
  }
  const n = out.length;
  const ends = n >= 2 && Math.abs(out[0]! - out[n - 2]!) < 1e-6 && Math.abs(out[1]! - out[n - 1]!) < 1e-6;
  return closed || ends ? out : null;
}

/** An SVG elliptical arc as points (SVG spec, endpoint to centre parametrization). */
function arc(out: number[], x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): void {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    out.push(x2, y2);
    return;
  }
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * yp) / ry, cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 16)));
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy);
  }
}
