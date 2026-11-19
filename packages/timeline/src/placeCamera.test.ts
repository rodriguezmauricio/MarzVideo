import { describe, expect, test } from "vitest";
import { cameraEdits, parseProject, type Project } from "@marz/format";
import { History } from "./history";
import { placeCamera, updateCamera } from "./commands";

const proj = (): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 1_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } },
    output: { width: 1920, height: 1080, fps: 60 },
  });
const free = { corner: "bottomLeft" as const, widthFrac: 0.3, marginFrac: 0.03, shape: "rect", x: 0.2, y: 0.5 };

describe("placeCamera", () => {
  test("sets the whole pip, one undo step", () => {
    const h = new History(proj());
    h.apply(placeCamera(free));
    expect(cameraEdits(h.current).pip).toEqual(free);
    h.undo();
    expect(cameraEdits(h.current).pip.x).toBeUndefined();
  });

  test("snapping back into a corner drops x and y", () => {
    const p = placeCamera(free)(proj());
    const q = placeCamera({ corner: "topRight", widthFrac: 0.3, marginFrac: 0.03, shape: "rect" })(p);
    expect(cameraEdits(q).pip).toEqual({ corner: "topRight", widthFrac: 0.3, marginFrac: 0.03, shape: "rect" });
  });

  test("the same pip returns the project itself (no undo step)", () => {
    const p = placeCamera(free)(proj());
    expect(placeCamera({ ...free })(p)).toBe(p);
  });

  test("keeps fields this build does not know", () => {
    const p = placeCamera({ ...free, glow: 1 } as typeof free)(proj());
    const q = placeCamera({ ...free, x: 0.3 })(p);
    expect((cameraEdits(q).pip as Record<string, unknown>).glow).toBe(1);
  });
});

describe("updateCamera and a free bubble", () => {
  test("picking a corner puts the bubble back in it", () => {
    const p = placeCamera(free)(proj());
    const q = updateCamera({ pip: { corner: "topLeft" } })(p);
    expect(cameraEdits(q).pip.x).toBeUndefined();
    expect(cameraEdits(q).pip.corner).toBe("topLeft");
  });

  test("picking the same corner of a free bubble still snaps it", () => {
    const p = placeCamera(free)(proj());
    expect(cameraEdits(updateCamera({ pip: { corner: "bottomLeft" } })(p)).pip.x).toBeUndefined();
  });

  test("a size change keeps the free position", () => {
    const p = placeCamera(free)(proj());
    expect(cameraEdits(updateCamera({ pip: { widthFrac: 0.16 } })(p)).pip.x).toBe(0.2);
  });
});
