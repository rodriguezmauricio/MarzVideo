// Keys on the video (design: docs/superpowers/specs/2026-11-19-keypress-overlay-design.md): keycap labels for
// the shortcuts logged while recording, drawn in output space after the frame, the camera and the captions.
import { keyItems, keysLook, type KeysLook, type Project } from "@marz/format";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Rect = { x: number; y: number; w: number; h: number };
type Tone = "ink" | "paper" | "accent";

/** Colours from tokens.css and the mono family, read by the caller (no colour lives in this package). */
export type KeysStyle = { ink: string; paper: string; accent: string; family: string };
/** Text width in pixels at a font size (the caller measures with a canvas, `keysMeasure`). */
export type KeysMeasure = (text: string, fontPx: number) => number;

export type KeysDraw = {
  fontPx: number;
  plate: Rect & { tone: Tone };
  text: Tone;
  outlinePx: number;
  caps: Array<Rect & { label: string; textX: number }>;
  plus: Array<{ x: number }>;
  count: { x: number; text: string } | null;
  /** Text baseline shared by every label. */
  baseline: number;
};

/** Cap text size: share of the output height (landscape) or width (vertical). */
export const KEYS_SIZE = 0.028;
export const KEYS_SIZE_VERTICAL = 0.042;
export const KEYS_SIZE_FACTOR = { S: 0.8, M: 1, L: 1.25 } as const;
/** Gap to the frame edges in landscape, share of the output height. */
export const KEYS_EDGE = 0.04;
const CAP_H = 1.9;
const CAP_PAD_X = 0.55;
const PLATE_PAD = 0.4;
const SEP = 0.35;
const OUTLINE = 0.08;
const MAX_WIDTH = 0.94;

const TONES: Record<KeysLook["style"], { plate: Tone; text: Tone }> = {
  ink: { plate: "ink", text: "paper" },
  paper: { plate: "paper", text: "ink" },
  accent: { plate: "accent", text: "ink" },
};

const SHORT: Record<string, string> = {
  Delete: "Del",
  Insert: "Ins",
  PageUp: "PgUp",
  PageDown: "PgDn",
  PrintScreen: "PrtSc",
  Backspace: "Bksp",
};

/** The label on a keycap: short names for the long keys, upper case. */
export const keyCapLabel = (name: string): string => (SHORT[name] ?? name).toUpperCase();

/** The combo shown at `srcUs` and where it goes, or null (none, hidden, or keys off). Pure: preview
 *  and export call it with their sizes. `area` is the box the plate stays in: the whole output in
 *  landscape (the 4% edge gap is added here), the safe area in the vertical export (`vertical` true). */
export function keysLayout(
  project: Project,
  srcUs: number,
  out: { width: number; height: number },
  measure: KeysMeasure,
  opts?: { area?: Rect; vertical?: boolean },
): KeysDraw | null {
  const look = keysLook(project);
  if (!look.show) return null;
  const item = keyItems(project).find((k) => srcUs >= k.startUs && srcUs < k.endUs);
  if (!item || item.hidden) return null;

  const vertical = opts?.vertical === true;
  const gap = vertical ? 0 : KEYS_EDGE * out.height;
  const a = opts?.area ?? { x: 0, y: 0, w: out.width, h: out.height };
  const area = { x: a.x + gap, y: a.y + gap, w: Math.max(1, a.w - 2 * gap), h: Math.max(1, a.h - 2 * gap) };
  const labels = item.keys.map(keyCapLabel);
  const countText = item.count > 1 ? `x${item.count}` : null;

  const widthAt = (f: number) => {
    const caps = labels.reduce((s, l) => s + measure(l, f) + 2 * CAP_PAD_X * f, 0);
    const plus = (labels.length - 1) * (measure("+", f) + 2 * SEP * f);
    const count = countText ? SEP * 2 * f + measure(countText, f) : 0;
    return caps + plus + count + 2 * PLATE_PAD * f;
  };
  let fontPx = (vertical ? KEYS_SIZE_VERTICAL * out.width : KEYS_SIZE * out.height) * (KEYS_SIZE_FACTOR[look.size] ?? 1);
  const w0 = widthAt(fontPx);
  if (w0 > area.w * MAX_WIDTH) fontPx *= (area.w * MAX_WIDTH) / w0;

  const pad = PLATE_PAD * fontPx;
  const capH = CAP_H * fontPx;
  const plateW = widthAt(fontPx);
  const plateH = capH + 2 * pad;
  const [row, side] = look.position.startsWith("top") ? ["top", look.position.slice(3)] : ["bottom", look.position.slice(6)];
  const x = side === "Left" ? area.x : side === "Right" ? area.x + area.w - plateW : area.x + (area.w - plateW) / 2;
  const y = row === "top" ? area.y : area.y + area.h - plateH;

  const top = y + pad;
  const baseline = top + capH / 2 + fontPx * 0.36;
  const caps: KeysDraw["caps"] = [];
  const plus: KeysDraw["plus"] = [];
  let cx = x + pad;
  labels.forEach((label, i) => {
    if (i > 0) {
      cx += SEP * fontPx;
      plus.push({ x: cx });
      cx += measure("+", fontPx) + SEP * fontPx;
    }
    const w = measure(label, fontPx) + 2 * CAP_PAD_X * fontPx;
    caps.push({ x: cx, y: top, w, h: capH, label, textX: cx + CAP_PAD_X * fontPx });
    cx += w;
  });
  const count = countText ? { x: cx + 2 * SEP * fontPx, text: countText } : null;
  const tones = TONES[look.style];
  return {
    fontPx,
    plate: { x, y, w: plateW, h: plateH, tone: tones.plate },
    text: tones.text,
    outlinePx: Math.max(1, Math.round(OUTLINE * fontPx)),
    caps,
    plus,
    count,
    baseline,
  };
}

export const keysFont = (fontPx: number, family: string) => `500 ${fontPx.toFixed(2)}px ${family}`;

/** Draws a keys layout: the plate, square keycap outlines, labels, "+" and the count. */
export function drawKeys(ctx: Ctx, d: KeysDraw, style: KeysStyle): void {
  const text = style[d.text];
  ctx.save();
  ctx.fillStyle = style[d.plate.tone];
  ctx.fillRect(d.plate.x, d.plate.y, d.plate.w, d.plate.h);
  const o = d.outlinePx;
  ctx.fillStyle = text;
  for (const c of d.caps) {
    // Whole strips, so preview and export put the outline on the same pixels (no stroke anti-aliasing drift).
    ctx.fillRect(c.x, c.y, c.w, o);
    ctx.fillRect(c.x, c.y + c.h - o, c.w, o);
    ctx.fillRect(c.x, c.y, o, c.h);
    ctx.fillRect(c.x + c.w - o, c.y, o, c.h);
  }
  ctx.font = keysFont(d.fontPx, style.family);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (const c of d.caps) ctx.fillText(c.label, c.textX, d.baseline);
  for (const p of d.plus) ctx.fillText("+", p.x, d.baseline);
  if (d.count) ctx.fillText(d.count.text, d.count.x, d.baseline);
  ctx.restore();
}

/** A `KeysMeasure` backed by a canvas context. */
export function keysMeasure(ctx: Ctx, family: string): KeysMeasure {
  const cache = new Map<string, number>();
  return (t, fontPx) => {
    const key = `${fontPx}|${t}`;
    let v = cache.get(key);
    if (v === undefined) {
      ctx.save();
      ctx.font = keysFont(fontPx, family);
      v = ctx.measureText(t).width;
      ctx.restore();
      cache.set(key, v);
    }
    return v;
  };
}
