// Vector drawings of the Windows system cursors, in cell units (32 per cell at 100% scale), hotspot at
// (0, 0). White fill with a black outline, like the default Windows scheme. These are cursor pictures
// (video content), not UI, so they use the system cursor's white and black, not design tokens.
import type { CursorDraw } from "./cursor";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Shape = CursorDraw["shape"];

const WHITE = "#ffffff";
const BLACK = "#000000";
const OUTLINE = 1.2;

function poly(ctx: Ctx, pts: number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
  ctx.closePath();
}

function fillOutline(ctx: Ctx): void {
  ctx.fillStyle = WHITE;
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = OUTLINE;
  ctx.lineJoin = "miter";
  ctx.fill();
  ctx.stroke();
}

/** A thin black line with a white edge (text beam, crosshair). */
function edgedLines(ctx: Ctx, segs: number[][]): void {
  for (const [w, c] of [
    [3.4, WHITE],
    [1.4, BLACK],
  ] as const) {
    ctx.beginPath();
    for (const s of segs) {
      ctx.moveTo(s[0]!, s[1]!);
      ctx.lineTo(s[2]!, s[3]!);
    }
    ctx.lineWidth = w;
    ctx.strokeStyle = c;
    ctx.lineCap = "square";
    ctx.stroke();
  }
}

const ARROW = [0, 0, 0, 17, 4.5, 13, 7.5, 20, 10, 19, 7, 12, 12.5, 12];
/** Index finger up, hotspot at the fingertip. */
const HAND = [-1.6, 1, -0.6, 0, 0.6, 0, 1.6, 1, 1.6, 8, 4, 7.4, 6.4, 8, 8.6, 8.8, 10, 10, 10, 15.5, 8, 20, -1, 20, -3.5, 16.5, -6.5, 12.5, -6.5, 11, -5, 10.5, -1.6, 13];
/** A double-headed arrow along x, centred on the hotspot. */
const DOUBLE = [-10, 0, -5.5, -4.5, -5.5, -1.6, 5.5, -1.6, 5.5, -4.5, 10, 0, 5.5, 4.5, 5.5, 1.6, -5.5, 1.6, -5.5, 4.5];

function arrow(ctx: Ctx): void {
  poly(ctx, ARROW);
  fillOutline(ctx);
}

/** A small ring beside the arrow (busy in the background) or a question mark (help). */
function badge(ctx: Ctx, kind: "ring" | "help"): void {
  ctx.save();
  ctx.translate(15, 15);
  if (kind === "ring") {
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = BLACK;
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = WHITE;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, -2, 3, Math.PI, Math.PI * 2.4);
    ctx.lineTo(0, 2.5);
    for (const [w, c] of [
      [3.4, WHITE],
      [1.5, BLACK],
    ] as const) {
      ctx.lineWidth = w;
      ctx.strokeStyle = c;
      ctx.stroke();
    }
    ctx.fillStyle = BLACK;
    ctx.fillRect(-0.9, 4.2, 1.8, 1.8);
  }
  ctx.restore();
}

function double(ctx: Ctx, angle: number): void {
  ctx.save();
  ctx.rotate(angle);
  poly(ctx, DOUBLE);
  fillOutline(ctx);
  ctx.restore();
}

/** Draw `shape` with its hotspot at (x, y), `scale` output pixels per cell unit. */
export function drawCursorShape(ctx: Ctx, shape: Shape, x: number, y: number, scale: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  switch (shape) {
    case "hand":
      poly(ctx, HAND);
      fillOutline(ctx);
      break;
    case "ibeam":
      edgedLines(ctx, [
        [0, -8, 0, 8],
        [-3, -8.5, 3, -8.5],
        [-3, 8.5, 3, 8.5],
      ]);
      break;
    case "cross":
      edgedLines(ctx, [
        [-9, 0, 9, 0],
        [0, -9, 0, 9],
      ]);
      break;
    case "wait":
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.lineWidth = 4.4;
      ctx.strokeStyle = BLACK;
      ctx.stroke();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = WHITE;
      ctx.stroke();
      break;
    case "progress":
      arrow(ctx);
      badge(ctx, "ring");
      break;
    case "help":
      arrow(ctx);
      badge(ctx, "help");
      break;
    case "move":
      double(ctx, 0);
      double(ctx, Math.PI / 2);
      break;
    case "sizeWE":
      double(ctx, 0);
      break;
    case "sizeNS":
      double(ctx, Math.PI / 2);
      break;
    case "sizeNWSE":
      double(ctx, Math.PI / 4);
      break;
    case "sizeNESW":
      double(ctx, -Math.PI / 4);
      break;
    case "no":
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.moveTo(-4.9, -4.9);
      ctx.lineTo(4.9, 4.9);
      ctx.lineWidth = 4.4;
      ctx.strokeStyle = WHITE;
      ctx.stroke();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = BLACK;
      ctx.stroke();
      break;
    default:
      arrow(ctx);
  }
  ctx.restore();
}
