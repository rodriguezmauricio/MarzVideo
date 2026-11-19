import type { Cut, LayoutKind, Zoom } from "@marz/format";

/** Block and inspector names: auto zooms are "Suggested", the rest are numbered by start time ("Zoom 1"...). */
export function zoomLabels(zooms: Zoom[]): Map<string, string> {
  const labels = new Map<string, string>();
  const own = zooms.filter((z) => z.origin !== "auto").sort((a, b) => a.startUs - b.startUs);
  own.forEach((z, i) => labels.set(z.id, `Zoom ${i + 1}`));
  for (const z of zooms) if (z.origin === "auto") labels.set(z.id, "Suggested");
  return labels;
}

/** The cut cap label: "Cut" for his own cuts, the reason for AI cuts ("Silence", "Um", "Mistake"). */
export function cutCapLabel(c: Cut): string {
  if (c.origin !== "ai") return "Cut";
  return c.reason === "silence" ? "Silence" : c.reason === "filler" ? "Um" : c.reason === "mistake" ? "Mistake" : "Cut";
}

/** Layout block and picker labels (DESIGN-SYSTEM.md "Layout lane"). */
export const LAYOUT_LABEL: Record<LayoutKind, string> = { pip: "Corner", side: "Side", camera: "Camera", screen: "Screen" };

/** Drawing lane and inspector names of the stroke tools. */
export const STROKE_LABEL: Record<import("@marz/format").StrokeTool, string> = {
  pen: "Pen",
  highlighter: "Highlighter",
  arrow: "Arrow",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
};
