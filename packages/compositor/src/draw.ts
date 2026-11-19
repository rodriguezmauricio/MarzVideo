import type { Box } from "./camera";
import { coverCrop } from "./layout";
import type { FrameSpec } from "./frame";
import { drawStrokes, type DrawLayer } from "./drawings";
import type { ClickDraw } from "./cursor";
import { drawCursorShape } from "./cursorShapes";
import { BACKDROP_FALLBACK, paintBackdrop, type BackgroundDraw } from "./background";
import { roundedPath } from "./path";

/** Click effect colours by token name. Callers pass the `tokens.css` values they read at run time. */
export type ClickColors = Record<ClickDraw["color"], string>;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The camera's 1px border: paper, the same value as `--paper` in apps/desktop/src/styles/tokens.css.
 *  Callers pass the token values they read at run time; this is the fallback. */
export const PIP_BORDER = "#ECEAE4";

/** The camera picture to draw on top: its frame and the frame's size, where it goes (`layoutAt`), the
 *  corner radius of its mask, whether it is drawn mirrored (the file never is) and its border
 *  (`width` in output pixels, 0 for none). */
export type CameraLayer = {
  source: CanvasImageSource;
  srcSize: { width: number; height: number };
  rect: Box;
  radius?: number;
  mirror: boolean;
  border?: { width: number; color: string };
};

/** Draw one frame: the cropped source scaled to `out` (into the layout's screen box, see
 *  `frameAt`), then the live drawing strokes, the click effects, the cursor, then the camera. Same code for
 *  preview and export. */
export function drawFrame(
  ctx: Ctx,
  source: CanvasImageSource,
  spec: FrameSpec,
  out: { width: number; height: number },
  camera?: CameraLayer | null,
  clickColors?: ClickColors,
  drawings?: DrawLayer | null,
): void {
  const { sx, sy, sw, sh } = spec.srcRect;
  const { dx, dy, dw, dh } = spec.dstRect;
  const bg = spec.background;
  if (bg) {
    drawBackdropAndFrame(ctx, bg, out, clickColors);
    ctx.save();
    roundedPath(ctx, bg.frame.x, bg.frame.y, bg.frame.w, bg.frame.h, bg.radius);
    ctx.clip();
    ctx.fillStyle = "#000000";
    ctx.fillRect(bg.frame.x, bg.frame.y, bg.frame.w, bg.frame.h);
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  if (drawings) drawStrokes(ctx, drawings.items, spec, drawings.colors, drawings.family);
  if (bg) ctx.restore();
  if (spec.clicks.length > 0) drawClicks(ctx, spec.clicks, clickColors);
  if (spec.cursor) drawCursorShape(ctx, spec.cursor.shape, spec.cursor.x, spec.cursor.y, spec.cursor.scale);
  if (camera) drawCamera(ctx, camera);
}

/** Border width in output pixels for a width given at 1080 output height (0 stays 0, else at least 1). */
export const borderPx = (widthAt1080: number, out: { height: number }): number =>
  widthAt1080 <= 0 ? 0 : Math.max(1, Math.round((widthAt1080 * out.height) / 1080));

/** The camera after screen and cursor: never zoomed, cover cropped into its box, clipped to its
 *  mask, border inside the box along the mask. */
export function drawCamera(ctx: Ctx, cam: CameraLayer): void {
  const { x, y, w, h } = cam.rect;
  if (w < 1 || h < 1) return;
  const r = Math.max(0, Math.min(cam.radius ?? 0, w / 2, h / 2));
  const c = coverCrop(cam.srcSize, cam.rect);
  ctx.save();
  if (r > 0) {
    roundedPath(ctx, x, y, w, h, r);
    ctx.clip();
  }
  if (cam.mirror) {
    // The crop is centred, so mirroring the box mirrors the picture.
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(cam.source, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
  } else {
    ctx.drawImage(cam.source, c.sx, c.sy, c.sw, c.sh, x, y, w, h);
  }
  ctx.restore();
  const b = cam.border ?? { width: 1, color: PIP_BORDER };
  if (b.width <= 0) return;
  ctx.save();
  if (r > 0) {
    roundedPath(ctx, x + b.width / 2, y + b.width / 2, w - b.width, h - b.width, Math.max(0, r - b.width / 2));
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.width;
    ctx.stroke();
  } else {
    // Whole-pixel strips, so preview and export put the border on the same pixels.
    ctx.fillStyle = b.color;
    ctx.fillRect(x, y, w, b.width);
    ctx.fillRect(x, y + h - b.width, w, b.width);
    ctx.fillRect(x, y, b.width, h);
    ctx.fillRect(x + w - b.width, y, b.width, h);
  }
  ctx.restore();
}

/** Click effects: rings (stroke) or discs (fill), with their opacity. Fallback colour: paper. */
export function drawClicks(ctx: Ctx, clicks: ClickDraw[], colors?: ClickColors): void {
  for (const c of clicks) {
    if (c.alpha <= 0 || c.r <= 0) continue;
    const color = colors?.[c.color] || PIP_BORDER;
    ctx.save();
    ctx.globalAlpha = c.alpha;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    if (c.fill) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = c.lineWidth;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** The backdrop over the whole output and the framed screen's shadow (an ink copy of the frame, under the
 *  picture, so only its shadow shows). */
function drawBackdropAndFrame(ctx: Ctx, bg: BackgroundDraw, out: { width: number; height: number }, colors?: ClickColors): void {
  const c = { ...BACKDROP_FALLBACK, ...colors };
  paintBackdrop(ctx, bg.style, out, c);
  if (!bg.shadow) return;
  const { x, y, w, h } = bg.frame;
  ctx.save();
  ctx.globalAlpha = bg.shadow.alpha;
  ctx.shadowColor = c.ink;
  ctx.shadowBlur = bg.shadow.blur;
  ctx.shadowOffsetY = bg.shadow.offsetY;
  ctx.fillStyle = c.ink;
  roundedPath(ctx, x, y, w, h, bg.radius);
  ctx.fill();
  ctx.restore();
}
