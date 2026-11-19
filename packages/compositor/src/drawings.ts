import { drawingStrokes, TEXT_SIZE_PER_WIDTH, type Project, type Stroke, type StrokeColor } from "@marz/format";
import type { FrameSpec } from "./frame";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Fade in after a stroke appears and out before it disappears. */
export const STROKE_FADE_US = 150_000;
/** Highlighter: lines 4x as wide at 40% opacity. */
export const HIGHLIGHTER_SCALE = 4;
export const HIGHLIGHTER_ALPHA = 0.4;
/** Arrow head: two lines this many line widths long, at this angle from the shaft. */
const HEAD_LEN = 3.5;
const HEAD_ANGLE = Math.PI / 6;

export type VisibleStroke = { stroke: Stroke; alpha: number };
export type StrokeColors = Record<StrokeColor, string>;
/** What `drawFrame` needs to draw the strokes: the visible ones, the token colours, the text font. */
export type DrawLayer = { items: VisibleStroke[]; colors: StrokeColors; family: string };

/** The strokes visible at source time `srcUs` with their opacity, in drawing order. */
export function strokesAt(project: Project, srcUs: number): VisibleStroke[] {
  const out: VisibleStroke[] = [];
  for (const s of drawingStrokes(project)) {
    if (srcUs < s.startUs || srcUs >= s.endUs) continue;
    const fade = Math.min(STROKE_FADE_US, (s.endUs - s.startUs) / 2);
    const alpha = Math.max(0, Math.min(1, (srcUs - s.startUs) / fade, (s.endUs - srcUs) / fade));
    out.push({ stroke: s, alpha });
  }
  return out;
}

/** Source pixels to output pixels for a frame: the shown source area (`srcRect`) goes to `dstRect`. */
export type StrokeMap = Pick<FrameSpec, "srcRect" | "dstRect">;

/** Draw the strokes through the frame's map, clipped to the shown picture. */
export function drawStrokes(ctx: Ctx, items: VisibleStroke[], map: StrokeMap, colors: StrokeColors, family: string): void {
  if (items.length === 0) return;
  const { sx, sy, sw, sh } = map.srcRect;
  const { dx, dy, dw, dh } = map.dstRect;
  if (sw <= 0 || sh <= 0) return;
  const kx = dw / sw;
  const ky = dh / sh;
  const k = (kx + ky) / 2;
  const X = (x: number) => dx + (x - sx) * kx;
  const Y = (y: number) => dy + (y - sy) * ky;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  for (const { stroke: s, alpha } of items) {
    if (alpha <= 0) continue;
    const color = colors[s.color] ?? colors.accent;
    const hl = s.tool === "highlighter";
    ctx.globalAlpha = alpha * (hl ? HIGHLIGHTER_ALPHA : 1);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = s.width * k * (hl ? HIGHLIGHTER_SCALE : 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const p = s.points;
    switch (s.tool) {
      case "pen":
      case "highlighter": {
        ctx.beginPath();
        ctx.moveTo(X(p[0]![0]), Y(p[0]![1]));
        // A single press is a dot.
        if (p.length === 1) ctx.lineTo(X(p[0]![0]) + 0.01, Y(p[0]![1]));
        for (let i = 1; i < p.length; i++) ctx.lineTo(X(p[i]![0]), Y(p[i]![1]));
        ctx.stroke();
        break;
      }
      case "arrow": {
        const [ax, ay, bx, by] = [X(p[0]![0]), Y(p[0]![1]), X(p[1]![0]), Y(p[1]![1])];
        const ang = Math.atan2(by - ay, bx - ax);
        const len = HEAD_LEN * ctx.lineWidth;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.moveTo(bx - len * Math.cos(ang - HEAD_ANGLE), by - len * Math.sin(ang - HEAD_ANGLE));
        ctx.lineTo(bx, by);
        ctx.lineTo(bx - len * Math.cos(ang + HEAD_ANGLE), by - len * Math.sin(ang + HEAD_ANGLE));
        ctx.stroke();
        break;
      }
      case "rect": {
        const [ax, ay, bx, by] = [X(p[0]![0]), Y(p[0]![1]), X(p[1]![0]), Y(p[1]![1])];
        ctx.beginPath();
        ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        ctx.stroke();
        break;
      }
      case "ellipse": {
        const [ax, ay, bx, by] = [X(p[0]![0]), Y(p[0]![1]), X(p[1]![0]), Y(p[1]![1])];
        ctx.beginPath();
        ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "text": {
        ctx.font = `700 ${s.width * TEXT_SIZE_PER_WIDTH * k}px ${family}`;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        ctx.fillText(s.text ?? "", X(p[0]![0]), Y(p[0]![1]));
        break;
      }
    }
  }
  ctx.restore();
}
