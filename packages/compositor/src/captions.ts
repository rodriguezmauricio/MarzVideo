type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

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

/** How captions look (the `@marz/format` caption style of an export preset, minus the line building). */
export type CaptionLookOpts = {
  style: "inkBand" | "paperBand" | "accentBand" | "plain";
  size: "S" | "M" | "L";
  position: "top" | "middle" | "bottom";
  /** Light the word being said. */
  highlight: boolean;
};
type Tone = "ink" | "paper" | "accent";

/** Everything `drawCaptions` needs: where the band and each word go, which word is lit, which tokens. */
export type CaptionDraw = {
  fontPx: number;
  band: (CaptionRect & { tone: Tone }) | null;
  text: Tone;
  lit: Tone;
  /** A box behind the lit word (on light bands, where accent text alone does not read). */
  litBox: Tone | null;
  /** Outline width in pixels around every word (Plain), 0 for none. */
  outlinePx: number;
  lines: Array<{ baseline: number; top: number; height: number; words: Array<{ text: string; x: number; w: number; lit: boolean }> }>;
};

const LINE_H = 1.15;
const PAD_Y = 0.35;
const PAD_X = 0.6;
/** In-frame captions: font size as a share of the frame height, gap to the frame edge as a share of the frame height. */
export const SUBTITLE_SIZE = 0.045;
const EDGE_GAP = 0.06;
/** In the vertical letterbox: font size as a share of the output width (word highlight; full subtitle
 * lines use the smaller size so 32 characters fit). */
export const HIGHLIGHT_SIZE = 0.075;
const LETTERBOX_SUBTITLE_SIZE = 0.055;
export const CAPTION_SIZE_FACTOR = { S: 0.8, M: 1, L: 1.25 } as const;
/** Lines never get wider than this share of the width they sit in; the font shrinks instead. */
const MAX_WIDTH = 0.94;
const OUTLINE = 0.08;
const LIT_PAD = 0.12;

const TONES: Record<CaptionLookOpts["style"], { band: Tone | null; text: Tone; lit: Tone; litBox: Tone | null }> = {
  inkBand: { band: "ink", text: "paper", lit: "accent", litBox: null },
  paperBand: { band: "paper", text: "ink", lit: "accent", litBox: "ink" },
  accentBand: { band: "accent", text: "ink", lit: "accent", litBox: "ink" },
  plain: { band: null, text: "paper", lit: "accent", litBox: null },
};

/** Which caption is on screen at output time `tOutUs` and where it goes. Pure: preview and export
 * call it with their own sizes and get the same layout scaled.
 * `frame` is where the picture sits in the output. When the output has ink above or below the frame
 * (the vertical letterbox) and the position is Top or Bottom, captions sit in that ink area;
 * otherwise inside the frame, 6 % of its height from the edge, or centred for Middle.
 * `area` (the smart vertical picture): captions go inside it instead (Top at its top, Bottom at its
 * bottom, Middle centred), sized on the output width like the vertical preset. */
export function captionLayout(
  blocks: CaptionBlock[],
  tOutUs: number,
  look: CaptionLookOpts,
  out: { width: number; height: number },
  frame: CaptionRect,
  measure: Measure,
  area?: CaptionRect,
): CaptionDraw | null {
  const block = blocks.find((b) => tOutUs >= b.startUs && tOutUs < b.endUs);
  if (!block || block.lines.length === 0) return null;
  const tones = TONES[look.style] ?? TONES.inkBand;
  const k = CAPTION_SIZE_FACTOR[look.size] ?? 1;

  const inkBelow = out.height - (frame.y + frame.h);
  const inkAbove = frame.y;
  const boxed = out.width * HIGHLIGHT_SIZE * LINE_H * 1.5;
  // A letterboxed output (ink above and below the picture) sizes captions on its width.
  const letterboxed = !area && Math.min(inkAbove, inkBelow) >= boxed;
  const inkArea =
    letterboxed && look.position === "bottom"
      ? { y: frame.y + frame.h, h: inkBelow }
      : letterboxed && look.position === "top"
        ? { y: 0, h: inkAbove }
        : null;
  const onWidth = letterboxed || !!area;
  const widthLimit = (area ? area.w : letterboxed ? out.width : frame.w) * MAX_WIDTH;
  const lineCount = block.lines.length;
  const wordsIn = (fontPx: number) => block.lines.map((l) => l.words.map((w) => measure(w.text, fontPx)));
  const linesW = (fontPx: number, ws: number[][]) => {
    const space = measure(" ", fontPx);
    return ws.map((w) => w.reduce((a, b) => a + b, 0) + space * Math.max(0, w.length - 1));
  };

  let fontPx = k * (onWidth ? out.width * (look.highlight ? HIGHLIGHT_SIZE : LETTERBOX_SUBTITLE_SIZE) : frame.h * SUBTITLE_SIZE);
  let widths = wordsIn(fontPx);
  let lineW = linesW(fontPx, widths);
  const banded = tones.band !== null;
  const widest = Math.max(...lineW) + (banded ? 2 * PAD_X * fontPx : 0);
  if (widest > widthLimit) {
    fontPx *= widthLimit / widest;
    widths = wordsIn(fontPx);
    lineW = linesW(fontPx, widths);
  }
  const space = measure(" ", fontPx);
  const lineH = fontPx * LINE_H;
  const textH = lineH * lineCount;
  const padY = banded ? PAD_Y * fontPx : 0;
  const boxH = textH + 2 * padY;
  const cx = area ? area.x + area.w / 2 : frame.x + frame.w / 2;

  let boxTop: number;
  if (area) boxTop = look.position === "top" ? area.y : look.position === "middle" ? area.y + (area.h - boxH) / 2 : area.y + area.h - boxH;
  else if (inkArea) boxTop = inkArea.y + (inkArea.h - boxH) / 2;
  else if (look.position === "top") boxTop = frame.y + EDGE_GAP * frame.h;
  else if (look.position === "middle") boxTop = frame.y + (frame.h - boxH) / 2;
  else boxTop = frame.y + frame.h - EDGE_GAP * frame.h - boxH;

  let band: CaptionDraw["band"] = null;
  if (tones.band) {
    const bandW = Math.max(...lineW) + 2 * PAD_X * fontPx;
    band = { x: cx - bandW / 2, y: boxTop, w: bandW, h: boxH, tone: tones.band };
  }
  const top = boxTop + padY;

  let lit = -1;
  if (look.highlight) {
    const all = block.lines.flatMap((l) => l.words);
    for (let i = 0; i < all.length; i++) if (all[i]!.startUs <= tOutUs) lit = i;
    if (lit < 0) lit = 0;
  }

  let n = 0;
  const lines = block.lines.map((l, li) => {
    let x = cx - lineW[li]! / 2;
    const words = l.words.map((w, wi) => {
      const item = { text: w.text, x, w: widths[li]![wi]!, lit: n++ === lit };
      x += widths[li]![wi]! + space;
      return item;
    });
    const lineTop = top + li * lineH;
    // Baseline about 0.8 em under the line top (Familjen Grotesk's ascent), centred in the line box.
    return { baseline: lineTop + (lineH - fontPx) / 2 + fontPx * 0.8, top: lineTop, height: lineH, words };
  });
  return {
    fontPx,
    band,
    text: tones.text,
    lit: tones.lit,
    litBox: tones.litBox,
    outlinePx: tones.band ? 0 : OUTLINE * fontPx,
    lines,
  };
}

export const captionFont = (fontPx: number, family: string) => `700 ${fontPx.toFixed(2)}px ${family}`;

/** Draws a caption layout. */
export function drawCaptions(ctx: Ctx, draw: CaptionDraw, style: CaptionStyle): void {
  const colour = (t: Tone) => style[t];
  ctx.save();
  if (draw.band) {
    ctx.fillStyle = colour(draw.band.tone);
    ctx.fillRect(draw.band.x, draw.band.y, draw.band.w, draw.band.h);
  }
  ctx.font = captionFont(draw.fontPx, style.family);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  if (draw.litBox) {
    const pad = LIT_PAD * draw.fontPx;
    ctx.fillStyle = colour(draw.litBox);
    for (const l of draw.lines) for (const w of l.words) if (w.lit) ctx.fillRect(w.x - pad, l.top, w.w + 2 * pad, l.height);
  }
  if (draw.outlinePx > 0) {
    ctx.strokeStyle = style.ink;
    ctx.lineWidth = draw.outlinePx * 2;
    ctx.lineJoin = "round";
    for (const l of draw.lines) for (const w of l.words) ctx.strokeText(w.text, w.x, l.baseline);
  }
  for (const l of draw.lines)
    for (const w of l.words) {
      ctx.fillStyle = colour(w.lit ? draw.lit : draw.text);
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
