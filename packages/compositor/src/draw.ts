import type { FrameSpec } from "./frame";

/** Draw one frame: the cropped source scaled to `out`, then the cursor sprite. Same code for preview and export. */
export function drawFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  spec: FrameSpec,
  out: { width: number; height: number },
): void {
  const { sx, sy, sw, sh } = spec.srcRect;
  const { dx, dy, dw, dh } = spec.dstRect;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  if (!spec.cursor) return;

  const s = out.height / 1080;
  ctx.save();
  ctx.translate(spec.cursor.x, spec.cursor.y);
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
