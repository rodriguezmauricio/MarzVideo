// The cursor layer and click effects (design: docs/superpowers/specs/2026-11-19-cursor-clicks-design.md).
// Everything is measured in captured pixels and scaled like the picture, so it follows zooms and layouts.
import {
  clickSettings,
  cursorKind,
  cursorSections,
  cursorSize,
  type ClickColor,
  type ClickEvent,
  type CursorEvent,
  type CursorShape,
  type CursorShapeEvent,
  type MarzEvent,
  type Project,
} from "@marz/format";

type SrcRect = { sx: number; sy: number; sw: number; sh: number };
type DstRect = { dx: number; dy: number; dw: number; dh: number };

/** The cursor to draw: hotspot in output pixels, shape, and output pixels per cell unit (32 per cell). */
export type CursorDraw = { x: number; y: number; shape: Exclude<CursorShape, "hidden" | "other">; scale: number };
/** One click effect: centre and radius in output pixels, stroke or fill, opacity, token colour name. */
export type ClickDraw = { x: number; y: number; r: number; lineWidth: number; fill: boolean; alpha: number; color: ClickColor };

/** The cell size Windows draws at 100% scale; shapes are drawn in this unit. */
export const CURSOR_CELL = 32;
const RIPPLE_US = 500_000;
const PULSE_US = 400_000;
const RING_MIN_US = 250_000;
/** A held button stops showing its ring after this long. */
const RING_MAX_US = 10_000_000;
const SIZE_FACTOR = { S: 0.7, M: 1, L: 1.4 } as const;

type Index = { moves: CursorEvent[]; shapes: CursorShapeEvent[]; downs: ClickEvent[]; ups: ClickEvent[] };
const indexes = new WeakMap<MarzEvent[], Index>();

/** The events split by kind, sorted by time (cached per events array). */
function indexOf(events: MarzEvent[]): Index {
  let ix = indexes.get(events);
  if (ix) return ix;
  ix = { moves: [], shapes: [], downs: [], ups: [] };
  for (const e of events) {
    if (e.type === "cursor") ix.moves.push(e);
    else if (e.type === "cursorShape") ix.shapes.push(e);
    else if (e.type === "click") (e.state === "down" ? ix.downs : ix.ups).push(e);
  }
  for (const list of Object.values(ix)) (list as { tUs: number }[]).sort((a, b) => a.tUs - b.tUs);
  indexes.set(events, ix);
  return ix;
}

/** Index of the last item with tUs <= t, or -1. */
function lastAtOrBefore(list: { tUs: number }[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.tUs <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function sectionAt(project: Project, srcUs: number) {
  return cursorSections(project).find((s) => s.startUs <= srcUs && srcUs < s.endUs);
}

/** Whether the cursor shows at `srcUs` (blocks first, then the whole-video setting; never when baked). */
export function cursorShownAt(project: Project, srcUs: number): boolean {
  if (cursorKind(project) === "baked") return false;
  const s = sectionAt(project, srcUs);
  return s ? !s.hide : !project.edits.cursor.hidden;
}

/** The click effect style for a press at `srcUs`, or null when effects are off there. */
function clickStyleAt(project: Project, srcUs: number) {
  const c = clickSettings(project);
  const s = sectionAt(project, srcUs);
  return (s ? s.clicks : c.on) ? c.style : null;
}

const shapeAt = (ix: Index, t: number): CursorShapeEvent | undefined => ix.shapes[lastAtOrBefore(ix.shapes, t)];
const inside = (x: number, y: number, r: SrcRect) => x >= r.sx && x <= r.sx + r.sw && y >= r.sy && y <= r.sy + r.sh;
const toOut = (x: number, y: number, s: SrcRect, d: DstRect) => ({
  x: d.dx + ((x - s.sx) / s.sw) * d.dw,
  y: d.dy + ((y - s.sy) / s.sh) * d.dh,
});

/** The cursor at `srcUs`: the last recorded position and shape, no smoothing. Null when not shown. */
export function cursorAt(project: Project, events: MarzEvent[], srcUs: number, srcRect: SrcRect, dstRect: DstRect): CursorDraw | null {
  if (!cursorShownAt(project, srcUs)) return null;
  const ix = indexOf(events);
  const m = ix.moves[lastAtOrBefore(ix.moves, srcUs)];
  if (!m || !inside(m.x, m.y, srcRect)) return null;
  const sh = shapeAt(ix, srcUs);
  if (sh?.shape === "hidden") return null;
  const shape = !sh || sh.shape === "other" ? "arrow" : (sh.shape as CursorDraw["shape"]);
  const px = sh?.px ?? CURSOR_CELL;
  const screenScale = dstRect.dw / srcRect.sw;
  return { ...toOut(m.x, m.y, srcRect, dstRect), shape, scale: (px / CURSOR_CELL) * cursorSize(project) * screenScale };
}

/** The click effects to draw at `srcUs`, oldest first. */
export function clickEffectsAt(project: Project, events: MarzEvent[], srcUs: number, srcRect: SrcRect, dstRect: DstRect): ClickDraw[] {
  const ix = indexOf(events);
  const { color, size } = clickSettings(project);
  const screenScale = dstRect.dw / srcRect.sw;
  const out: ClickDraw[] = [];
  for (let i = lastAtOrBefore(ix.downs, srcUs); i >= 0; i--) {
    const d = ix.downs[i]!;
    const age = srcUs - d.tUs;
    if (age >= RING_MAX_US) break;
    const style = clickStyleAt(project, d.tUs);
    if (!style || !inside(d.x, d.y, srcRect)) continue;
    const R = 0.75 * (shapeAt(ix, d.tUs)?.px ?? CURSOR_CELL) * SIZE_FACTOR[size] * screenScale;
    const lineWidth = Math.max(1, R / 6);
    const base = { ...toOut(d.x, d.y, srcRect, dstRect), color };
    if (style === "ripple") {
      if (age >= RIPPLE_US) continue;
      const p = age / RIPPLE_US;
      const e = 1 - (1 - p) ** 3;
      out.push({ ...base, r: R * (0.25 + 1.35 * e), lineWidth, fill: false, alpha: 1 - p });
    } else if (style === "pulse") {
      if (age >= PULSE_US) continue;
      const p = age / PULSE_US;
      out.push({ ...base, r: R * (0.5 + 0.6 * p), lineWidth, fill: true, alpha: 0.45 * (1 - p) });
    } else {
      let upEv: ClickEvent | undefined;
      for (let j = lastAtOrBefore(ix.ups, d.tUs - 1) + 1; j < ix.ups.length && !upEv; j++) if (ix.ups[j]!.button === d.button) upEv = ix.ups[j];
      const endUs = Math.max(d.tUs + RING_MIN_US, upEv?.tUs ?? d.tUs + RING_MAX_US);
      if (srcUs >= endUs) continue;
      out.push({ ...base, r: R, lineWidth, fill: false, alpha: 1 });
    }
  }
  return out.reverse();
}
