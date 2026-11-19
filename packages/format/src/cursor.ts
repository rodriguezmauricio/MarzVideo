// Cursor and click settings (design: docs/superpowers/specs/2026-11-19-cursor-clicks-design.md).
// The schema keeps these fields loose (passthrough) so unknown values survive a save; these helpers
// read the values this build knows and fall back to the defaults.
import type { Project } from "./project";

/** Cursor shapes in `cursorShape` events (same list as the capture engine). */
export const CURSOR_SHAPES = [
  "arrow", "hand", "ibeam", "wait", "progress", "cross", "move", "sizeNS", "sizeWE", "sizeNWSE", "sizeNESW", "no", "help",
  "hidden", "other",
] as const;
export type CursorShape = (typeof CURSOR_SHAPES)[number];

/** "layer": the picture has no cursor, the editor draws it. "baked": the cursor is in the picture. */
export type CursorKind = "layer" | "baked";
export const CURSOR_SIZE_LIST = [1, 1.5, 2] as const;
export type CursorSize = (typeof CURSOR_SIZE_LIST)[number];

/** A cursor block on the Cursor lane (source time). Inside it, `hide` and `clicks` decide. */
export type CursorSection = { id: string; startUs: number; endUs: number; hide: boolean; clicks: boolean };

export const CLICK_STYLE_LIST = ["ripple", "pulse", "ring"] as const;
export const CLICK_COLOR_LIST = ["accent", "paper", "ink"] as const;
export const CLICK_SIZE_LIST = ["S", "M", "L"] as const;
export type ClickStyle = (typeof CLICK_STYLE_LIST)[number];
export type ClickColor = (typeof CLICK_COLOR_LIST)[number];
export type ClickSize = (typeof CLICK_SIZE_LIST)[number];
export type ClickSettings = { on: boolean; style: ClickStyle; color: ClickColor; size: ClickSize };

const pick = <T extends string | number>(list: readonly T[], v: unknown, fallback: T): T =>
  (list as readonly unknown[]).includes(v) ? (v as T) : fallback;

export function cursorKind(p: Project): CursorKind {
  return (p.source as { cursor?: unknown }).cursor === "baked" ? "baked" : "layer";
}

export function cursorSize(p: Project): CursorSize {
  return pick(CURSOR_SIZE_LIST, (p.edits.cursor as { size?: unknown }).size, 1);
}

const isSection = (s: unknown): s is CursorSection => {
  const o = s as Partial<CursorSection> | null;
  return (
    !!o && typeof o.id === "string" && Number.isInteger(o.startUs) && Number.isInteger(o.endUs) &&
    o.endUs! > o.startUs! && typeof o.hide === "boolean" && typeof o.clicks === "boolean"
  );
};

/** The raw `edits.cursor.sections` list (anything), for writing it back with unknown entries kept. */
export function rawCursorSections(p: Project): unknown[] {
  const s = (p.edits.cursor as { sections?: unknown }).sections;
  return Array.isArray(s) ? s : [];
}

/** The cursor blocks this build can read, by start time. */
export function cursorSections(p: Project): CursorSection[] {
  return rawCursorSections(p)
    .filter(isSection)
    .map(({ id, startUs, endUs, hide, clicks }) => ({ id, startUs, endUs, hide, clicks }))
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
}

export function clickSettings(p: Project): ClickSettings {
  const c = p.edits.clicks as { effect?: unknown; style?: unknown; color?: unknown; size?: unknown };
  const effectStyle = (CLICK_STYLE_LIST as readonly unknown[]).includes(c.effect) ? (c.effect as ClickStyle) : null;
  return {
    on: effectStyle !== null,
    style: effectStyle ?? pick(CLICK_STYLE_LIST, c.style, "ripple"),
    color: pick(CLICK_COLOR_LIST, c.color, "accent"),
    size: pick(CLICK_SIZE_LIST, c.size, "M"),
  };
}
