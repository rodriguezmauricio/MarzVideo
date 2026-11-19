import type { Box } from "./camera";
import { coverCrop } from "./layout";
import type { FrameSpec } from "./frame";

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
 *  `frameAt`), then the cursor sprite, then the camera. Same code for preview and export. */
export function drawFrame(ctx: Ctx, source: CanvasImageSource, spec: FrameSpec, out: { width: number; height: number }, camera?: CameraLayer | null): void {
  const { sx, sy, sw, sh } = spec.srcRect;
  const { dx, dy, dw, dh } = spec.dstRect;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  if (spec.cursor) drawCursor(ctx, spec.cursor, out);
  if (camera) drawCamera(ctx, camera);
}

/** Border width in output pixels for a width given at 1080 output height (0 stays 0, else at least 1). */
export const borderPx = (widthAt1080: number, out: { height: number }): number =>
  widthAt1080 <= 0 ? 0 : Math.max(1, Math.round((widthAt1080 * out.height) / 1080));

function roundedPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

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

function drawCursor(ctx: Ctx, cursor: { x: number; y: number }, out: { width: number; height: number }): void {
  const s = out.height / 1080;
  ctx.save();
  ctx.translate(cursor.x, cursor.y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.5, 13);
  ctx.lineTo(7.5, 20);
  ctx.lineTo(10, 19);
  ctx.lineTo(7, 12);
  ctx.lineTo(12.5, 12);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 1.2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
