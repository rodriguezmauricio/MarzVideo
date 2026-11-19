import { describe, expect, it } from "vitest";
import { parseProject, verticalEdits } from "@marz/format";
import { addHold, removeHold, setVertical, updateHold } from "./vertical";

const project = (vertical?: unknown) =>
  parseProject({
    version: 1,
    id: "p",
    name: "P",
    createdAt: "2026-11-19T00:00:00Z",
    durationUs: 10_000_000,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: vertical === undefined ? {} : { vertical },
  });

describe("Frame block commands", () => {
  it("adds in free time, stops at the next block, clamps x", () => {
    let p = addHold({ id: "a", startUs: 4_000_000, endUs: 6_000_000, x: 0.4 })(project());
    p = addHold({ id: "b", startUs: 5_000_000, endUs: 9_000_000, x: 1.5 })(p);
    p = addHold({ id: "c", startUs: 1_000_000, endUs: 5_000_000, x: 0.2 })(p);
    expect(verticalEdits(p).holds.map((h) => [h.id, h.startUs, h.endUs, h.x])).toEqual([
      ["c", 1_000_000, 4_000_000, 0.2],
      ["a", 4_000_000, 6_000_000, 0.4],
      ["b", 6_000_000, 9_000_000, 1],
    ]);
  });

  it("no room: unchanged", () => {
    const p = addHold({ id: "a", startUs: 0, endUs: 10_000_000, x: 0.4 })(project());
    expect(addHold({ id: "b", startUs: 3_000_000, endUs: 4_000_000, x: 0.4 })(p)).toBe(p);
  });

  it("updates aim and time between neighbours; moves keep their length; nothing changed returns p", () => {
    let p = addHold({ id: "a", startUs: 1_000_000, endUs: 2_000_000, x: 0.4 })(project());
    p = addHold({ id: "b", startUs: 5_000_000, endUs: 6_000_000, x: 0.4 })(p);
    expect(updateHold("a", { x: 0.4 })(p)).toBe(p);
    p = updateHold("a", { x: 0.9 })(p);
    p = updateHold("a", { startUs: 4_500_000, endUs: 5_500_000 })(p);
    expect(verticalEdits(p).holds[0]).toEqual({ id: "a", startUs: 4_000_000, endUs: 5_000_000, x: 0.9 });
    p = updateHold("b", { endUs: 20_000_000 })(p);
    expect(verticalEdits(p).holds[1]!.endUs).toBe(10_000_000);
  });

  it("removes, keeping holds and fields this build cannot read", () => {
    let p = project({ later: 1, holds: [{ id: "x", startUs: 1, endUs: 0 }, { id: "a", startUs: 0, endUs: 1_000_000, x: 0.5 }] });
    p = removeHold("a")(p);
    expect((p.edits as Record<string, any>).vertical).toEqual({ later: 1, holds: [{ id: "x", startUs: 1, endUs: 0 }] });
  });

  it("sets framing and the camera slot as one change each", () => {
    const p0 = project();
    expect(setVertical({ framing: "follow" })(p0)).toBe(p0);
    const p1 = setVertical({ framing: "fit" })(p0);
    expect(verticalEdits(p1).framing).toBe("fit");
    const p2 = setVertical({ cameraSlot: "bottom" })(p1);
    expect((p2.edits as Record<string, any>).vertical.cameraSlot).toBe("bottom");
    expect(setVertical({ cameraSlot: "bottom" })(p2)).toBe(p2);
  });
});
