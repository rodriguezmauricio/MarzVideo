import type { Box } from "./camera";
import type { FrameSpec } from "./frame";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The camera's 1px border: paper, the same value as `--paper` in apps/desktop/src/styles/tokens.css. */
export const PIP_BORDER = "#ECEAE4";

/** The camera picture to draw on top: its frame, where it goes (`cameraLayout`) and whether it is
 *  drawn mirrored (the file never is). */
export type CameraLayer = { source: CanvasImageSource; rect: Box; mirror: boolean };

/** Draw one frame: the cropped source scaled to `out`, then the cursor sprite, then the camera
 *  picture-in-picture. Same code for preview and export. */
export function drawFrame(ctx: Ctx, source: CanvasImageSource, spec: FrameSpec, out: { width: number; height: number }, camera?: CameraLayer | null): void {
  const { sx, sy, sw, sh } = spec.srcRect;
  const { dx, dy, dw, dh } = spec.dstRect;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  if (spec.cursor) drawCursor(ctx, spec.cursor, out);
  if (camera) drawCamera(ctx, camera, out);
}

/** The camera after screen and cursor: never zoomed, 1px paper border at output scale (1px on 1080). */
export function drawCamera(ctx: Ctx, cam: CameraLayer, out: { width: number; height: number }): void {
  const { x, y, w, h } = cam.rect;
  ctx.save();
  if (cam.mirror) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(cam.source, 0, 0, w, h);
  } else {
    ctx.drawImage(cam.source, x, y, w, h);
  }
  ctx.restore();
  const b = Math.max(1, Math.round(out.height / 1080));
  ctx.fillStyle = PIP_BORDER;
  ctx.fillRect(x, y, w, b);
  ctx.fillRect(x, y + h - b, w, b);
  ctx.fillRect(x, y, b, h);
  ctx.fillRect(x + w - b, y, b, h);
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
