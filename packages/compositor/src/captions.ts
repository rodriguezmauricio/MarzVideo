type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type CaptionLook = "subtitles" | "highlight";
/** One block of caption lines in output time (the shape `blockSpans` in `@marz/autoedit` returns). */
export type CaptionBlock = {
  startUs: number;
  endUs: number;
  lines: Array<{ words: Array<{ text: string; startUs: number; endUs: number }> }>;
};
export type CaptionRect = { x: number; y: number; w: number; h: number };
/** Colours and font, taken from tokens.css by the caller so no colour lives in this package. */
export type CaptionStyle = { ink: string; paper: string; accent: string; family: string };
/** Text width in pixels for a font size (the caller measures with a canvas). */
export type Measure = (text: string, fontPx: number) => number;

/** Everything `drawCaptions` needs: where the band and each word go, which word is lit. */
export type CaptionDraw = {
  fontPx: number;
  band: CaptionRect | null;
  lines: Array<{ baseline: number; words: Array<{ text: string; x: number; lit: boolean }> }>;
};

const LINE_H = 1.15;
const PAD_Y = 0.35;
const PAD_X = 0.6;
/** Subtitles: font size as a share of the frame height, bottom gap as a share of the frame height. */
export const SUBTITLE_SIZE = 0.045;
const SUBTITLE_BOTTOM = 0.06;
/** Highlight in the vertical letterbox: font size as a share of the output width. */
export const HIGHLIGHT_SIZE = 0.075;

/** Which caption is on screen at output time `tOutUs` and where it goes. Pure: preview and export
 * call it with their own sizes and get the same layout scaled. */
export function captionLayout(
  blocks: CaptionBlock[],
  tOutUs: number,
  look: CaptionLook,
  out: { width: number; height: number },
  frame: CaptionRect,
  measure: Measure,
): CaptionDraw | null {
  const block = blocks.find((b) => tOutUs >= b.startUs && tOutUs < b.endUs);
  if (!block || block.lines.length === 0) return null;

  const inkBelow = out.height - (frame.y + frame.h);
  const letterbox = look === "highlight" && inkBelow >= out.width * HIGHLIGHT_SIZE * LINE_H * 1.5;
  const fontPx = letterbox ? out.width * HIGHLIGHT_SIZE : frame.h * SUBTITLE_SIZE;
  const space = measure(" ", fontPx);
  const lineH = fontPx * LINE_H;

  let lit = -1;
  if (look === "highlight") {
    const all = block.lines.flatMap((l) => l.words);
    for (let i = 0; i < all.length; i++) if (all[i]!.startUs <= tOutUs) lit = i;
    if (lit < 0) lit = 0;
  }

  const widths = block.lines.map((l) => l.words.map((w) => measure(w.text, fontPx)));
  const lineW = widths.map((ws) => ws.reduce((a, b) => a + b, 0) + space * Math.max(0, ws.length - 1));
  const textH = lineH * block.lines.length;
  const cx = frame.x + frame.w / 2;
  let top: number;
  let band: CaptionRect | null = null;
  if (letterbox) {
    top = frame.y + frame.h + (inkBelow - textH) / 2;
  } else {
    const bandH = textH + 2 * PAD_Y * fontPx;
    const bandW = Math.max(...lineW) + 2 * PAD_X * fontPx;
    const bandBottom = frame.y + frame.h - SUBTITLE_BOTTOM * frame.h;
    band = { x: cx - bandW / 2, y: bandBottom - bandH, w: bandW, h: bandH };
    top = band.y + PAD_Y * fontPx;
  }

  let k = 0;
  const lines = block.lines.map((l, li) => {
    let x = cx - lineW[li]! / 2;
    const words = l.words.map((w, wi) => {
      const item = { text: w.text, x, lit: k++ === lit };
      x += widths[li]![wi]! + space;
      return item;
    });
    // Baseline about 0.8 em under the line top (Familjen Grotesk's ascent), centred in the line box.
    return { baseline: top + li * lineH + (lineH - fontPx) / 2 + fontPx * 0.8, words };
  });
  return { fontPx, band, lines };
}

export const captionFont = (fontPx: number, family: string) => `700 ${fontPx.toFixed(2)}px ${family}`;

/** Draws a caption layout. */
export function drawCaptions(ctx: Ctx, draw: CaptionDraw, style: CaptionStyle): void {
  ctx.save();
  if (draw.band) {
    ctx.fillStyle = style.ink;
    ctx.fillRect(draw.band.x, draw.band.y, draw.band.w, draw.band.h);
  }
  ctx.font = captionFont(draw.fontPx, style.family);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (const l of draw.lines)
    for (const w of l.words) {
      ctx.fillStyle = w.lit ? style.accent : style.paper;
      ctx.fillText(w.text, w.x, l.baseline);
    }
  ctx.restore();
}

/** A `Measure` backed by a canvas context. */
export function canvasMeasure(ctx: Ctx, family: string): Measure {
  const cache = new Map<string, number>();
  return (text, fontPx) => {
    const key = `${fontPx}|${text}`;
    let v = cache.get(key);
    if (v === undefined) {
      ctx.save();
      ctx.font = captionFont(fontPx, family);
      v = ctx.measureText(text).width;
      ctx.restore();
      cache.set(key, v);
    }
    return v;
  };
}
