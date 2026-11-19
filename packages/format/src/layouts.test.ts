import { describe, expect, test } from "vitest";
import { cameraBorder, cameraEdits, cameraScenes, DEFAULT_CAMERA_BORDER, parseProject, serializeProject } from "./project";
import { parseEvents } from "./events";

const base = (camera?: object) => ({
  version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
  source: { width: 1920, height: 1080, fps: 60 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } },
  output: { width: 1920, height: 1080, fps: 60 },
  edits: { zooms: [], cuts: [], ...(camera ? { camera } : {}) },
});
const pip = { corner: "bottomRight", widthFrac: 0.22, marginFrac: 0.03, shape: "circle" };

describe("camera layouts in project.json", () => {
  test("old projects: no border, no scenes, default border is today's 1px paper", () => {
    const p = parseProject(base());
    expect(cameraBorder(p)).toEqual({ width: 1, color: "paper" });
    expect(DEFAULT_CAMERA_BORDER).toEqual({ width: 1, color: "paper" });
    expect(cameraScenes(p)).toEqual([]);
  });

  test("reads shape, border, scenes and liveImported", () => {
    const p = parseProject(
      base({
        visible: true, mirror: true, pip, border: { width: 4, color: "accent" }, liveImported: true,
        scenes: [{ id: "l1", startUs: 1_000_000, endUs: 3_000_000, layout: "side", origin: "live" }],
      }),
    );
    expect(cameraEdits(p).pip.shape).toBe("circle");
    expect(cameraBorder(p)).toEqual({ width: 4, color: "accent" });
    expect(cameraEdits(p).liveImported).toBe(true);
    expect(cameraScenes(p)).toEqual([{ id: "l1", startUs: 1_000_000, endUs: 3_000_000, layout: "side", origin: "live" }]);
  });

  test("an unknown layout reads as pip and is written back unchanged", () => {
    const raw = base({ visible: true, mirror: true, pip, scenes: [{ id: "l1", startUs: 0, endUs: 1_000_000, layout: "floating", origin: "manual" }] });
    const p = parseProject(raw);
    expect(cameraScenes(p)[0]!.layout).toBe("pip");
    const out = JSON.parse(serializeProject(p));
    expect(out.edits.camera.scenes[0].layout).toBe("floating");
  });

  test("an unknown border colour reads as paper and is kept on save", () => {
    const p = parseProject(base({ visible: true, mirror: true, pip, border: { width: 2, color: "gold" } }));
    expect(cameraBorder(p)).toEqual({ width: 2, color: "paper" });
    expect(JSON.parse(serializeProject(p)).edits.camera.border.color).toBe("gold");
  });

  test("scenes come back sorted by start", () => {
    const p = parseProject(
      base({
        visible: true, mirror: true, pip,
        scenes: [
          { id: "b", startUs: 5_000_000, endUs: 6_000_000, layout: "camera", origin: "manual" },
          { id: "a", startUs: 1_000_000, endUs: 2_000_000, layout: "screen", origin: "manual" },
        ],
      }),
    );
    expect(cameraScenes(p).map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("a scene without a valid range is dropped from the typed list but the file still opens", () => {
    const p = parseProject(base({ visible: true, mirror: true, pip, scenes: [{ id: "x", startUs: 5, endUs: 2, layout: "side" }, "junk"] }));
    expect(cameraScenes(p)).toEqual([]);
  });
});

describe("layout events", () => {
  const header = JSON.stringify({ type: "header", version: 1, source: { width: 1920, height: 1080, fps: 60 }, startedAt: "x" });
  test("parses layout presses and skips unknown layouts", () => {
    const text = [header, '{"tUs":100,"type":"layout","layout":"side"}', '{"tUs":200,"type":"layout","layout":"weird"}'].join("\n");
    expect(parseEvents(text).events).toEqual([{ tUs: 100, type: "layout", layout: "side" }]);
  });
});
