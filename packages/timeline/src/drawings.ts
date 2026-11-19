import { drawingEdits, drawingStrokes, readStroke, type DrawEvent, type DrawingEdits, type MarzEvent, type Point, type Project, type Stroke, type StrokeTool, TEXT_SIZE_PER_WIDTH } from "@marz/format";
import type { Command } from "./commands";

/** Shortest stroke on the timeline. */
export const MIN_STROKE_US = 100_000;

type Box = { x: number; y: number; w: number; h: number };
export type StrokePatch = Partial<Pick<Stroke, "startUs" | "endUs" | "color" | "width" | "points" | "text">>;

function withDrawings(p: Project, d: DrawingEdits): Project {
  return { ...p, edits: { ...p.edits, drawings: d } };
}

const KNOWN_TOOLS: readonly StrokeTool[] = ["pen", "highlighter", "arrow", "rect", "ellipse", "text"];

/** Turn the live `draw` events of `events.jsonl` into strokes, once per project (`liveImported`).
 *  Each `add` makes a stroke from its press time to the next `remove` of its id or `clear`, else the
 *  end of the video. Returns `p` when there is nothing to import. */
export const importLiveDrawings =
  (events: MarzEvent[]): Command =>
  (p) => {
    const cur = drawingEdits(p);
    if (cur.liveImported) return p;
    const D = p.durationUs;
    const ops = events.filter((e): e is DrawEvent => e.type === "draw");
    if (!ops.some((e) => e.op === "add")) return p;
    const open = new Map<string, Stroke>();
    const done: Stroke[] = [];
    const close = (s: Stroke, at: number) => {
      const endUs = Math.min(D, at);
      if (endUs - s.startUs >= MIN_STROKE_US) done.push({ ...s, endUs });
    };
    let n = 0;
    for (const e of ops) {
      if (e.op === "add") {
        if (!(KNOWN_TOOLS as readonly string[]).includes(e.stroke.tool)) continue;
        const startUs = Math.max(0, Math.min(e.startUs, e.tUs));
        if (startUs >= D) continue;
        n += 1;
        const raw = {
          id: `live-stroke-${n}`,
          startUs,
          endUs: D,
          tool: e.stroke.tool,
          color: e.stroke.color,
          width: e.stroke.width,
          points: e.stroke.points,
          ...(e.stroke.text !== undefined ? { text: e.stroke.text } : {}),
          origin: "live",
        };
        const s = readStroke(raw);
        if (!s) continue;
        const prev = open.get(e.id);
        if (prev) close(prev, e.tUs);
        open.set(e.id, s);
      } else if (e.op === "remove") {
        const s = open.get(e.id);
        if (s) close(s, e.tUs);
        open.delete(e.id);
      } else {
        for (const s of open.values()) close(s, e.tUs);
        open.clear();
      }
    }
    for (const s of open.values()) close(s, D);
    done.sort((a, b) => a.startUs - b.startUs);
    return withDrawings(p, { ...cur, strokes: [...cur.strokes, ...done], liveImported: true });
  };

/** Change a stroke: time (kept inside the video, at least `MIN_STROKE_US` long), colour, width,
 *  points or text. Fields this build does not know stay. Returns `p` when nothing changes. */
export const updateStroke =
  (id: string, patch: StrokePatch): Command =>
  (p) => {
    const cur = drawingStrokes(p).find((s) => s.id === id);
    if (!cur) return p;
    const D = p.durationUs;
    const len = cur.endUs - cur.startUs;
    const isMove = patch.startUs !== undefined && patch.endUs !== undefined && patch.endUs - patch.startUs === len;
    let startUs = cur.startUs;
    let endUs = cur.endUs;
    if (isMove) {
      startUs = Math.max(0, Math.min(patch.startUs!, D - len));
      endUs = startUs + len;
    } else {
      if (patch.startUs !== undefined) startUs = Math.max(0, Math.min(patch.startUs, (patch.endUs ?? endUs) - MIN_STROKE_US));
      if (patch.endUs !== undefined) endUs = Math.min(D, Math.max(patch.endUs, startUs + MIN_STROKE_US));
    }
    const next: Record<string, unknown> = { startUs, endUs };
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.width !== undefined && patch.width > 0) next.width = patch.width;
    if (patch.points !== undefined && patch.points.length > 0) next.points = patch.points.map((q) => [q[0], q[1]]);
    if (patch.text !== undefined && patch.text.trim() !== "") next.text = patch.text;
    const changed = Object.entries(next).some(([k, v]) => JSON.stringify(v) !== JSON.stringify((cur as Record<string, unknown>)[k]));
    if (!changed) return p;
    const d = drawingEdits(p);
    const strokes = d.strokes.map((raw) => (readStroke(raw)?.id === id ? { ...(raw as object), ...next } : raw));
    return withDrawings(p, { ...d, strokes });
  };

export const removeStroke =
  (id: string): Command =>
  (p) => {
    const d = drawingEdits(p);
    const strokes = d.strokes.filter((raw) => readStroke(raw)?.id !== id);
    if (strokes.length === d.strokes.length) return p;
    return withDrawings(p, { ...d, strokes });
  };

/** Rough width of a text stroke's line in source pixels (the editor measures the real font when it
 *  can; this is the fallback and what the tests use). */
export const textWidthGuess = (text: string, size: number): number => Math.max(1, text.length) * size * 0.55;

/** The stroke's box in source pixels, line width included. `measure` gives a text line's width. */
export function strokeBounds(s: Stroke, measure: (text: string, size: number) => number = textWidthGuess): Box {
  if (s.tool === "text") {
    const size = s.width * TEXT_SIZE_PER_WIDTH;
    const [x, y] = s.points[0]!;
    return { x, y, w: measure(s.text ?? "", size), h: size * 1.15 };
  }
  const xs = s.points.map((q) => q[0]);
  const ys = s.points.map((q) => q[1]);
  const pad = (s.tool === "highlighter" ? 4 * s.width : s.width) / 2 + (s.tool === "arrow" ? 3.5 * s.width * 0.5 : 0);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
}

function distToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Does a press at (x, y) (source pixels) touch the stroke? `tol` adds to half the line width. Text:
 *  inside its box. Rect and ellipse: on the outline. */
export function hitStroke(s: Stroke, x: number, y: number, tol: number, measure?: (text: string, size: number) => number): boolean {
  if (s.tool === "text") {
    const b = strokeBounds(s, measure);
    return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
  }
  const half = (s.tool === "highlighter" ? 4 * s.width : s.width) / 2 + tol;
  const pts = s.points;
  if (s.tool === "rect") {
    const [a, b] = [pts[0]!, pts[1]!];
    const c: Point[] = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    return c.some((q, i) => distToSegment(x, y, q, c[(i + 1) % 4]!) <= half);
  }
  if (s.tool === "ellipse") {
    const [a, b] = [pts[0]!, pts[1]!];
    const cx = (a[0] + b[0]) / 2;
    const cy = (a[1] + b[1]) / 2;
    const rx = Math.abs(b[0] - a[0]) / 2;
    const ry = Math.abs(b[1] - a[1]) / 2;
    const ring: Point[] = Array.from({ length: 48 }, (_, i) => [cx + rx * Math.cos((i / 48) * 2 * Math.PI), cy + ry * Math.sin((i / 48) * 2 * Math.PI)]);
    return ring.some((q, i) => distToSegment(x, y, q, ring[(i + 1) % 48]!) <= half);
  }
  if (pts.length === 1) return Math.hypot(x - pts[0]![0], y - pts[0]![1]) <= half;
  for (let i = 0; i + 1 < pts.length; i++) if (distToSegment(x, y, pts[i]!, pts[i + 1]!) <= half) return true;
  return false;
}

/** The topmost stroke (last started) at (x, y) among `strokes`, or null. */
export function strokeAtPoint(strokes: Stroke[], x: number, y: number, tol: number, measure?: (text: string, size: number) => number): Stroke | null {
  for (let i = strokes.length - 1; i >= 0; i--) if (hitStroke(strokes[i]!, x, y, tol, measure)) return strokes[i]!;
  return null;
}

/** Points moved by (dx, dy). */
export const movePoints = (pts: Point[], dx: number, dy: number): Point[] => pts.map((q) => [q[0] + dx, q[1] + dy]);

/** Points scaled by (sx, sy) about (ax, ay). */
export const scalePoints = (pts: Point[], ax: number, ay: number, sx: number, sy: number): Point[] =>
  pts.map((q) => [ax + (q[0] - ax) * sx, ay + (q[1] - ay) * sy]);
