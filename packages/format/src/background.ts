import type { Project } from "./project";

/** Backdrop behind the framed screen (design `2026-11-19-background-frame-design.md`). "off": the screen fills the frame. */
export const BACKGROUND_STYLES = ["off", "ink", "paper", "glow", "grid"] as const;
export type BackgroundStyle = (typeof BACKGROUND_STYLES)[number];
export const BACKGROUND_PADDINGS = ["S", "M", "L"] as const;
export type BackgroundPadding = (typeof BACKGROUND_PADDINGS)[number];
export type BackgroundCorners = "square" | "round";

/** `edits.background` as this build reads it. One background per project. */
export type BackgroundEdits = { style: BackgroundStyle; padding: BackgroundPadding; corners: BackgroundCorners; shadow: boolean };

export const DEFAULT_BACKGROUND_EDITS: BackgroundEdits = { style: "off", padding: "M", corners: "round", shadow: true };

const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** The raw `edits.background` object (edits are passthrough, so unknown fields survive older builds). */
export function rawBackground(p: Project): Record<string, unknown> {
  const v = (p.edits as Record<string, unknown>).background;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The background in force. Missing, unknown or broken values read as their defaults (off). */
export function backgroundEdits(p: Project): BackgroundEdits {
  const b = rawBackground(p);
  const d = DEFAULT_BACKGROUND_EDITS;
  return {
    style: pick(b.style, BACKGROUND_STYLES, d.style),
    padding: pick(b.padding, BACKGROUND_PADDINGS, d.padding),
    corners: pick(b.corners, ["square", "round"] as const, d.corners),
    shadow: typeof b.shadow === "boolean" ? b.shadow : d.shadow,
  };
}
