import { describe, expect, test } from "vitest";
import { drawingEdits, drawingStrokes, readStroke, strokeWidths } from "./drawings";
import { parseEvents } from "./events";
import { parseProject, serializeProject } from "./project";

const base = (drawings?: object) => ({
  version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
  source: { width: 1920, height: 1080, fps: 60 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 60 },
  edits: { zooms: [], cuts: [], ...(drawings ? { drawings } : {}) },
});
const pen = { id: "s1", startUs: 1_000_000, endUs: 3_000_000, tool: "pen", color: "rec", width: 6, points: [[10, 20], [30, 40]], origin: "live" };

describe("edits.drawings", () => {
  test("old projects have no strokes", () => {
    const p = parseProject(base());
    expect(drawingStrokes(p)).toEqual([]);
    expect(drawingEdits(p)).toEqual({ strokes: [] });
  });

  test("reads strokes sorted by start, with liveImported", () => {
    const text = { ...pen, id: "t1", startUs: 500_000, tool: "text", text: "Here", points: [[5, 5]] };
    const p = parseProject(base({ strokes: [pen, text], liveImported: true }));
    expect(drawingStrokes(p).map((s) => s.id)).toEqual(["t1", "s1"]);
    expect(drawingStrokes(p)[1]).toEqual(pen);
    expect(drawingEdits(p).liveImported).toBe(true);
  });

  test("an unknown colour draws as accent and is written back unchanged", () => {
    const p = parseProject(base({ strokes: [{ ...pen, color: "blue" }] }));
    expect(drawingStrokes(p)[0]!.color).toBe("accent");
    expect(JSON.parse(serializeProject(p)).edits.drawings.strokes[0].color).toBe("blue");
  });

  test("strokes this build cannot draw are skipped but kept in the file", () => {
    const odd = [
      { ...pen, id: "a", tool: "star" },
      { ...pen, id: "b", endUs: 1_000_000 },
      { ...pen, id: "c", tool: "arrow", points: [[1, 1]] },
      { ...pen, id: "d", tool: "text", points: [[1, 1]] },
      "nonsense",
    ];
    const p = parseProject(base({ strokes: [...odd, pen] }));
    expect(drawingStrokes(p).map((s) => s.id)).toEqual(["s1"]);
    expect(JSON.parse(serializeProject(p)).edits.drawings.strokes).toHaveLength(6);
  });

  test("a stroke without origin reads as manual", () => {
    const { origin: _o, ...rest } = pen;
    expect(readStroke(rest)!.origin).toBe("manual");
  });

  test("widths scale with the source height", () => {
    expect(strokeWidths(1080)).toEqual({ thin: 3, medium: 6, thick: 12 });
    expect(strokeWidths(1800)).toEqual({ thin: 5, medium: 10, thick: 20 });
  });
});

describe("draw events", () => {
  const head = '{"type":"header","version":1,"source":{"width":1920,"height":1080,"fps":60},"startedAt":"2026-11-19T00:00:00Z"}';
  test("add, remove and clear are read; odd ones are skipped", () => {
    const lines = [
      head,
      '{"tUs":2000000,"type":"draw","op":"add","id":"s1","startUs":1500000,"stroke":{"tool":"pen","color":"accent","width":6,"points":[[1,2],[3,4]]}}',
      '{"tUs":2500000,"type":"draw","op":"remove","id":"s1"}',
      '{"tUs":3000000,"type":"draw","op":"clear"}',
      '{"tUs":3100000,"type":"draw","op":"spin"}',
      '{"tUs":3200000,"type":"draw","op":"add","id":"s2"}',
    ];
    const { events } = parseEvents(lines.join("\n"));
    expect(events.map((e) => (e.type === "draw" ? e.op : e.type))).toEqual(["add", "remove", "clear"]);
    const add = events[0]!;
    expect(add.type === "draw" && add.op === "add" && add.stroke.points).toEqual([[1, 2], [3, 4]]);
  });
});
