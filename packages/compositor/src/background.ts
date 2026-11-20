import { backgroundEdits, type BackgroundGradient, type BackgroundPadding, type BackgroundStyle, type Project } from "@marz/format";
import type { Box } from "./camera";

/** Background and frame (docs/superpowers/specs/2026-11-19-background-frame-design.md, image, blur and
 *  gradient: 2026-11-19-background-image-blur-design.md). Sizes are in pixels at a 1080 short side and scale
 *  with the output's short side. */
export const BACKGROUND_PADDING_PX: Record<BackgroundPadding, number> = { S: 40, M: 64, L: 96 };
export const BACKGROUND_RADIUS_PX = 16;
export const BACKGROUND_SHADOW = { blur: 40, offsetY: 12, alpha: 0.5 } as const;
/** Grid wallpaper: columns across the width, line strength. */
const GRID_COLUMNS = 12;
const GRID_ALPHA = 0.08;
/** Glow: accent strength at the bottom right corner. */
const GLOW_ALPHA = 0.55;
/** Blur backdrop: the screen is drawn into a canvas this many times smaller than the output (plus a bleed so
 *  the blur does not fade at the edges), blurred there, scaled up, then darkened with ink. */
export const BLUR_DOWNSCALE = 12;
const BLUR_PX = 2;
const BLUR_BLEED = 3 * BLUR_PX;
export const BLUR_DARKEN = 0.35;

export type BackdropStyle = Exclude<BackgroundStyle, "off">;
export type Shadow = { blur: number; offsetY: number; alpha: number };
/** The background of one frame: backdrop style (and gradient pair), the framed screen's box (output pixels),
 *  its corner radius, its shadow. */
export type BackgroundDraw = { style: BackdropStyle; gradient: BackgroundGradient; frame: Box; radius: number; shadow: Shadow | null };
/** What the backdrop is painted from: the style and its gradient pair. */
export type BackdropLook = { style: BackdropStyle; gradient: BackgroundGradient };
/** Pictures the backdrop may need: the current screen frame (Blur) and the loaded background image (Image). */
export type BackdropSources = { screen?: CanvasImageSource | null; image?: CanvasImageSource | null };
/** Token colours for the backdrop (read from tokens.css by the caller). */
export type BackdropColors = Record<"paper" | "ink" | "accent", string>;

/** Fallbacks: the same values as `--paper`, `--ink` and `--accent` in apps/desktop/src/styles/tokens.css. */
export const BACKDROP_FALLBACK: BackdropColors = { paper: "#ECEAE4", ink: "#0B0B0A", accent: "#D4FF3A" };

/** Gradient pairs: [top left, bottom right], as token names. */
const GRADIENT_STOPS: Record<BackgroundGradient, [keyof BackdropColors, keyof BackdropColors]> = {
  "ink-accent": ["ink", "accent"],
  "ink-paper": ["ink", "paper"],
  "paper-accent": ["paper", "accent"],
};

type Size = { width: number; height: number };
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The background in output pixels for an output of size `out`, or null when it is off. */
export function backgroundPx(
  project: Project,
  out: Size,
): { style: BackdropStyle; gradient: BackgroundGradient; pad: number; radius: number; shadow: Shadow | null } | null {
  const b = backgroundEdits(project);
  if (b.style === "off") return null;
  const k = Math.min(out.width, out.height) / 1080;
  const s = BACKGROUND_SHADOW;
  return {
    style: b.style,
    gradient: b.gradient,
    pad: Math.round(BACKGROUND_PADDING_PX[b.padding] * k),
    radius: b.corners === "round" ? Math.round(BACKGROUND_RADIUS_PX * k) : 0,
    shadow: b.shadow ? { blur: Math.round(s.blur * k), offsetY: Math.round(s.offsetY * k), alpha: s.alpha } : null,
  };
}

/** `box` shrunk by the background margin (at most a quarter of its width or height each side). `box` itself when off. */
export function framedBox(project: Project, box: Box, out: Size): Box {
  const bg = backgroundPx(project, out);
  if (!bg) return box;
  const pad = Math.min(bg.pad, box.w / 4, box.h / 4);
  return { x: box.x + pad, y: box.y + pad, w: box.w - 2 * pad, h: box.h - 2 * pad };
}

/** Paint the backdrop over the whole output. Gradients, blur and the grid are video content, not editor UI.
 *  Image and Blur show ink while their picture is missing (not loaded, file gone, no frame yet). */
export function paintBackdrop(ctx: Ctx, look: BackdropLook | BackdropStyle, out: Size, colors: BackdropColors, sources: BackdropSources = {}): void {
  const { style, gradient } = typeof look === "string" ? { style: look, gradient: "ink-accent" as BackgroundGradient } : look;
  const { width: w, height: h } = out;
  ctx.save();
  ctx.fillStyle = style === "paper" ? colors.paper : colors.ink;
  ctx.fillRect(0, 0, w, h);
  if (style === "glow") {
    const g = ctx.createRadialGradient(w, h, 0, w, h, Math.hypot(w, h) * 0.8);
    g.addColorStop(0, colors.accent);
    g.addColorStop(1, colors.ink);
    ctx.globalAlpha = GLOW_ALPHA;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else if (style === "grid") {
    const cell = w / GRID_COLUMNS;
    const line = Math.max(1, Math.round(Math.min(w, h) / 1080));
    ctx.globalAlpha = GRID_ALPHA;
    ctx.fillStyle = colors.paper;
    for (let x = cell; x < w; x += cell) ctx.fillRect(Math.round(x), 0, line, h);
    for (let y = h - cell; y > 0; y -= cell) ctx.fillRect(0, Math.round(y), w, line);
  } else if (style === "gradient") {
    const [from, to] = GRADIENT_STOPS[gradient] ?? GRADIENT_STOPS["ink-accent"];
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, colors[from]);
    g.addColorStop(1, colors[to]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else if (style === "image" && sources.image) {
    const scaled = coverScaled(sources.image, out);
    if (scaled) ctx.drawImage(scaled, 0, 0, w, h);
  } else if (style === "blur" && sources.screen) {
    paintBlur(ctx, sources.screen, out, colors);
  }
  ctx.restore();
}

/** The pixel size of an image, video element, decoded frame, bitmap or canvas; null before it is known. */
export function sourceSize(source: CanvasImageSource): Size | null {
  const m = source as Partial<{
    videoWidth: number;
    videoHeight: number;
    displayWidth: number;
    displayHeight: number;
    naturalWidth: number;
    naturalHeight: number;
    width: unknown;
    height: unknown;
  }>;
  const w = m.videoWidth || m.displayWidth || m.naturalWidth || (typeof m.width === "number" ? m.width : 0);
  const h = m.videoHeight || m.displayHeight || m.naturalHeight || (typeof m.height === "number" ? m.height : 0);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** The centred crop of a `src`-sized picture that covers a box of `w` x `h` without stretching. */
export function coverSource(src: Size, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  const k = Math.max(w / src.width, h / src.height);
  const sw = w / k;
  const sh = h / k;
  return { sx: (src.width - sw) / 2, sy: (src.height - sh) / 2, sw, sh };
}

type Scratch = OffscreenCanvas | HTMLCanvasElement;
/** A scratch canvas, or null where there is none (tests in Node). */
function makeCanvas(w: number, h: number): Scratch | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/** The background image cover-fitted to the output size, scaled once per image and size. Without a scratch
 *  canvas the image itself is returned with its crop drawn every frame. */
const coverCache = new WeakMap<object, { w: number; h: number; canvas: Scratch }>();
function coverScaled(image: CanvasImageSource, out: Size): CanvasImageSource | null {
  const w = Math.round(out.width);
  const h = Math.round(out.height);
  const hit = coverCache.get(image);
  if (hit && hit.w === w && hit.h === h) return hit.canvas;
  const size = sourceSize(image);
  if (!size) return null;
  const canvas = makeCanvas(w, h);
  const c = canvas?.getContext("2d") as Ctx | null | undefined;
  if (!canvas || !c) return null;
  c.imageSmoothingQuality = "high";
  const r = coverSource(size, w, h);
  c.drawImage(image, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  coverCache.set(image, { w, h, canvas });
  return canvas;
}

/** One small canvas reused for every blurred frame (remade when the size changes). */
let blurCanvas: { w: number; h: number; canvas: Scratch; ctx: Ctx } | null = null;
function smallCanvas(w: number, h: number) {
  if (blurCanvas && blurCanvas.w === w && blurCanvas.h === h) return blurCanvas;
  const canvas = makeCanvas(w, h);
  const ctx = canvas?.getContext("2d") as Ctx | null | undefined;
  if (!canvas || !ctx) return null;
  blurCanvas = { w, h, canvas, ctx };
  return blurCanvas;
}

/** Blur: the whole screen frame cover-fitted, blurred on a small canvas, scaled up over the output, darkened. */
function paintBlur(ctx: Ctx, screen: CanvasImageSource, out: Size, colors: BackdropColors): void {
  const size = sourceSize(screen);
  if (!size) return;
  const sw = Math.max(1, Math.round(out.width / BLUR_DOWNSCALE));
  const sh = Math.max(1, Math.round(out.height / BLUR_DOWNSCALE));
  const small = smallCanvas(sw + 2 * BLUR_BLEED, sh + 2 * BLUR_BLEED);
  if (!small) return;
  const s = small.ctx;
  s.save();
  s.clearRect(0, 0, small.w, small.h);
  s.filter = `blur(${BLUR_PX}px)`;
  // Cover the small canvas plus a bleed on every side, so the blur has picture to pull in at the edges.
  const r = coverSource(size, small.w + 2 * BLUR_BLEED, small.h + 2 * BLUR_BLEED);
  s.drawImage(screen, r.sx, r.sy, r.sw, r.sh, -BLUR_BLEED, -BLUR_BLEED, small.w + 2 * BLUR_BLEED, small.h + 2 * BLUR_BLEED);
  s.restore();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small.canvas, BLUR_BLEED, BLUR_BLEED, sw, sh, 0, 0, out.width, out.height);
  ctx.globalAlpha = BLUR_DARKEN;
  ctx.fillStyle = colors.ink;
  ctx.fillRect(0, 0, out.width, out.height);
}
