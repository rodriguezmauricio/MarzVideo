import type { Corner, Project } from "./project";

/** How the vertical export frames the 16:9 recording: follow the action (a 9:16 window that aims at
 *  the cursor, clicks and zooms) or fit the whole picture with bars (the M1 export). */
export type VerticalFraming = "follow" | "fit";
export type CameraSlot = "top" | "bottom";

/** A Frame block: the vertical window held at `x` (its centre, a share of the screen width) from
 *  `startUs` to `endUs` (source time). */
export type VerticalHold = { id: string; startUs: number; endUs: number; x: number };

/** `edits.vertical` as this build reads it. */
export type VerticalEdits = { framing: VerticalFraming; cameraSlot: CameraSlot; holds: VerticalHold[] };

const isHold = (h: unknown): h is VerticalHold => {
  const r = h as Partial<VerticalHold> | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    Number.isInteger(r.startUs) &&
    Number.isInteger(r.endUs) &&
    r.endUs! > r.startUs! &&
    typeof r.x === "number" &&
    Number.isFinite(r.x)
  );
};

const slotForCorner = (c: Corner | string | undefined): CameraSlot => (c === "topLeft" || c === "topRight" ? "top" : "bottom");

/** The raw `edits.vertical` object (edits are passthrough, so it survives older builds). */
export function rawVertical(p: Project): Record<string, unknown> {
  const v = (p.edits as Record<string, unknown>).vertical;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The vertical settings in force. Missing or unknown values read as their defaults: framing
 *  "follow", the camera slot from the camera corner, no holds. Holds this build cannot read are left
 *  out (they stay in the file). Holds are sorted by start; x is kept between 0 and 1. */
export function verticalEdits(p: Project): VerticalEdits {
  const v = rawVertical(p);
  const framing: VerticalFraming = v.framing === "fit" ? "fit" : "follow";
  const corner = (p.edits.camera?.pip.corner ?? "bottomRight") as Corner;
  const cameraSlot: CameraSlot = v.cameraSlot === "top" || v.cameraSlot === "bottom" ? v.cameraSlot : slotForCorner(corner);
  const list = Array.isArray(v.holds) ? (v.holds as unknown[]) : [];
  const holds = list
    .filter(isHold)
    .map((h) => ({ id: h.id, startUs: h.startUs, endUs: h.endUs, x: Math.min(1, Math.max(0, h.x)) }))
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  return { framing, cameraSlot, holds };
}
