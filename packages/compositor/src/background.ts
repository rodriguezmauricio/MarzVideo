import { backgroundEdits, type BackgroundPadding, type BackgroundStyle, type Project } from "@marz/format";
import type { Box } from "./camera";

/** Background and frame (docs/superpowers/specs/2026-11-19-background-frame-design.md). Sizes are in
 *  pixels at a 1080 short side and scale with the output's short side. */
export const BACKGROUND_PADDING_PX: Record<BackgroundPadding, number> = { S: 40, M: 64, L: 96 };
export const BACKGROUND_RADIUS_PX = 16;
export const BACKGROUND_SHADOW = { blur: 40, offsetY: 12, alpha: 0.5 } as const;
/** Grid wallpaper: columns across the width, line strength. */
const GRID_COLUMNS = 12;
const GRID_ALPHA = 0.08;
/** Glow: accent strength at the bottom right corner. */
const GLOW_ALPHA = 0.55;

export type BackdropStyle = Exclude<BackgroundStyle, "off">;
export type Shadow = { blur: number; offsetY: number; alpha: number };
/** The background of one frame: backdrop style, the framed screen's box (output pixels), its corner radius, its shadow. */
export type BackgroundDraw = { style: BackdropStyle; frame: Box; radius: number; shadow: Shadow | null };
/** Token colours for the backdrop (read from tokens.css by the caller). */
export type BackdropColors = Record<"paper" | "ink" | "accent", string>;

/** Fallbacks: the same values as `--paper`, `--ink` and `--accent` in apps/desktop/src/styles/tokens.css. */
export const BACKDROP_FALLBACK: BackdropColors = { paper: "#ECEAE4", ink: "#0B0B0A", accent: "#D4FF3A" };

type Size = { width: number; height: number };
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The background in output pixels for an output of size `out`, or null when it is off. */
export function backgroundPx(project: Project, out: Size): { style: BackdropStyle; pad: number; radius: number; shadow: Shadow | null } | null {
  const b = backgroundEdits(project);
  if (b.style === "off") return null;
  const k = Math.min(out.width, out.height) / 1080;
  const s = BACKGROUND_SHADOW;
  return {
    style: b.style,
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

/** Paint the backdrop over the whole output. Gradients and the grid are video content, not editor UI. */
export function paintBackdrop(ctx: Ctx, style: BackdropStyle, out: Size, colors: BackdropColors): void {
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
  }
  ctx.restore();
}
