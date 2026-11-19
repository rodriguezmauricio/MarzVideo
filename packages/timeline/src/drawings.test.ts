import { describe, expect, test } from "vitest";
import { drawingEdits, drawingStrokes, parseProject, serializeProject, type MarzEvent, type Stroke } from "@marz/format";
import { hitStroke, importLiveDrawings, removeStroke, scalePoints, strokeAtPoint, strokeBounds, updateStroke } from "./drawings";

const project = (strokes?: unknown[]) =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 60 },
    edits: { zooms: [], cuts: [], ...(strokes ? { drawings: { strokes } } : {}) },
  });
const stroke = { tool: "pen", color: "accent", width: 6, points: [[100, 100], [200, 100]] };
const add = (tUs: number, id: string, startUs: number, s: object = stroke): MarzEvent =>
  ({ tUs, type: "draw", op: "add", id, startUs, stroke: s }) as MarzEvent;
const pen: Stroke = { id: "s1", startUs: 1_000_000, endUs: 3_000_000, tool: "pen", color: "accent", width: 6, points: [[100, 100], [200, 100]], origin: "live" };

describe("importLiveDrawings", () => {
  test("add to remove, add to clear, add to the end; marks liveImported", () => {
    const events: MarzEvent[] = [
      add(2_000_000, "a", 1_500_000),
      add(3_000_000, "b", 2_800_000, { ...stroke, tool: "text", text: "Here", points: [[5, 5]] }),
      { tUs: 4_000_000, type: "draw", op: "remove", id: "a" },
      { tUs: 6_000_000, type: "draw", op: "clear" },
      add(9_000_000, "c", 8_000_000, { ...stroke, tool: "arrow" }),
    ];
    const p = importLiveDrawings(events)(project());
    const s = drawingStrokes(p);
    expect(s.map((x) => [x.tool, x.startUs, x.endUs, x.origin])).toEqual([
      ["pen", 1_500_000, 4_000_000, "live"],
      ["text", 2_800_000, 6_000_000, "live"],
      ["arrow", 8_000_000, 20_000_000, "live"],
    ]);
    expect(s[1]!.text).toBe("Here");
    expect(drawingEdits(p).liveImported).toBe(true);
    expect(importLiveDrawings(events)(p)).toBe(p);
  });

  test("nothing to import leaves the project as it is", () => {
    const p = project();
    expect(importLiveDrawings([])(p)).toBe(p);
    expect(importLiveDrawings([{ tUs: 1, type: "draw", op: "clear" }])(p)).toBe(p);
  });

  test("unknown tools and strokes too short or past the end are dropped", () => {
    const events: MarzEvent[] = [
      add(1_000_000, "a", 900_000, { ...stroke, tool: "star" }),
      add(2_000_000, "b", 2_000_000),
      { tUs: 2_050_000, type: "draw", op: "clear" },
      add(21_000_000, "c", 20_500_000),
      add(5_000_000, "d", 4_000_000),
    ];
    const s = drawingStrokes(importLiveDrawings(events)(project()));
    expect(s.map((x) => x.startUs)).toEqual([4_000_000]);
  });
});

describe("stroke commands", () => {
  test("updateStroke moves in time keeping the length, inside the video", () => {
    const p = project([pen]);
    const q = updateStroke("s1", { startUs: 19_000_000, endUs: 21_000_000 })(p);
    expect(drawingStrokes(q)[0]).toMatchObject({ startUs: 18_000_000, endUs: 20_000_000 });
  });

  test("updateStroke trims with a minimum length", () => {
    const q = updateStroke("s1", { endUs: 1_000_010 })(project([pen]));
    expect(drawingStrokes(q)[0]).toMatchObject({ startUs: 1_000_000, endUs: 1_100_000 });
  });

  test("colour, width, points, text; unchanged returns the same project; unknown fields stay", () => {
    const p = project([{ ...pen, extra: 1 }]);
    expect(updateStroke("s1", { color: "accent" })(p)).toBe(p);
    expect(updateStroke("nope", { color: "rec" })(p)).toBe(p);
    const q = updateStroke("s1", { color: "rec", width: 12, points: [[0, 0], [1, 1]] })(p);
    expect(drawingStrokes(q)[0]).toMatchObject({ color: "rec", width: 12, points: [[0, 0], [1, 1]] });
    expect(JSON.parse(serializeProject(q)).edits.drawings.strokes[0].extra).toBe(1);
    expect(updateStroke("s1", { text: "  " })(p)).toBe(p);
  });

  test("removeStroke", () => {
    const p = project([pen, { ...pen, id: "s2" }]);
    expect(drawingStrokes(removeStroke("s1")(p)).map((s) => s.id)).toEqual(["s2"]);
    expect(removeStroke("x")(p)).toBe(p);
  });
});

describe("geometry", () => {
  test("bounds include half the line width (highlighter 4x)", () => {
    expect(strokeBounds(pen)).toEqual({ x: 97, y: 97, w: 106, h: 6 });
    expect(strokeBounds({ ...pen, tool: "highlighter" })).toEqual({ x: 88, y: 88, w: 124, h: 24 });
    const t = strokeBounds({ ...pen, tool: "text", text: "Hi", points: [[10, 20]] }, (txt, size) => txt.length * size);
    expect(t).toEqual({ x: 10, y: 20, w: 96, h: 48 * 1.15 });
  });

  test("hit on the line, the outline of rect and ellipse, inside text", () => {
    expect(hitStroke(pen, 150, 104, 2)).toBe(true);
    expect(hitStroke(pen, 150, 110, 2)).toBe(false);
    const rect: Stroke = { ...pen, tool: "rect", points: [[0, 0], [100, 50]] };
    expect(hitStroke(rect, 100, 25, 2)).toBe(true);
    expect(hitStroke(rect, 50, 25, 2)).toBe(false);
    const ell: Stroke = { ...pen, tool: "ellipse", points: [[0, 0], [100, 50]] };
    expect(hitStroke(ell, 50, 0, 3)).toBe(true);
    expect(hitStroke(ell, 50, 25, 3)).toBe(false);
    const text: Stroke = { ...pen, tool: "text", text: "Hi", points: [[0, 0]] };
    expect(hitStroke(text, 20, 20, 0)).toBe(true);
  });

  test("strokeAtPoint picks the topmost", () => {
    const a = { ...pen, id: "a" };
    const b = { ...pen, id: "b" };
    expect(strokeAtPoint([a, b], 150, 100, 2)!.id).toBe("b");
    expect(strokeAtPoint([a, b], 0, 0, 2)).toBeNull();
  });

  test("scalePoints about an anchor", () => {
    expect(scalePoints([[10, 10], [20, 30]], 10, 10, 2, 0.5)).toEqual([[10, 10], [30, 20]]);
  });
});
