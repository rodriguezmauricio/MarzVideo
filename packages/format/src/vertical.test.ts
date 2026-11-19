import { describe, expect, it } from "vitest";
import { parseProject, serializeProject } from "./project";
import { verticalEdits } from "./vertical";

const base = {
  version: 1,
  id: "p",
  name: "P",
  createdAt: "2026-11-19T00:00:00Z",
  durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 30 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 30 },
};

describe("verticalEdits", () => {
  it("defaults: follow, bottom slot, no holds", () => {
    expect(verticalEdits(parseProject(base))).toEqual({ framing: "follow", cameraSlot: "bottom", holds: [] });
  });

  it("takes the slot from a top camera corner", () => {
    const p = parseProject({ ...base, edits: { camera: { visible: true, mirror: true, pip: { corner: "topLeft", widthFrac: 0.2, marginFrac: 0.03, shape: "rect" } } } });
    expect(verticalEdits(p).cameraSlot).toBe("top");
  });

  it("reads holds sorted, clamps x, skips broken ones and keeps everything on save", () => {
    const vertical = {
      framing: "zigzag",
      cameraSlot: "top",
      holds: [
        { id: "b", startUs: 5_000_000, endUs: 6_000_000, x: 1.4 },
        { id: "a", startUs: 1_000_000, endUs: 2_000_000, x: 0.3 },
        { id: "bad", startUs: 3, endUs: 2, x: 0.5 },
        "junk",
      ],
      later: 7,
    };
    const p = parseProject({ ...base, edits: { vertical } });
    const v = verticalEdits(p);
    expect(v.framing).toBe("follow");
    expect(v.cameraSlot).toBe("top");
    expect(v.holds.map((h) => [h.id, h.x])).toEqual([["a", 0.3], ["b", 1]]);
    expect(JSON.parse(serializeProject(p)).edits.vertical).toEqual(vertical);
  });
});
