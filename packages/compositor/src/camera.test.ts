import { describe, expect, test } from "vitest";
import { DEFAULT_CAMERA_EDITS, parseProject, PIP_CORNERS, PIP_SIZES, type Corner } from "@marz/format";
import { cameraLayout, cameraMediaUs, pipRect } from "./camera";

const cam = { width: 1280, height: 720 };
const pip = (corner: Corner, widthFrac: number = PIP_SIZES.M) => ({ corner, widthFrac, marginFrac: 0.03, shape: "rect" });

const project = (camera?: object, edits?: object) =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-18T00:00:00Z", durationUs: 10_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, ...(camera ? { camera } : {}) },
    output: { width: 1920, height: 1080, fps: 60 },
    edits: { zooms: [], cuts: [], ...(edits ? { camera: edits } : {}) },
  });

describe("pipRect", () => {
  test("default: bottom right, 22% of 1920 wide, 16:9 kept, 3% margin", () => {
    expect(pipRect({ width: 1920, height: 1080 }, cam, DEFAULT_CAMERA_EDITS.pip)).toEqual({ x: 1440, y: 785, w: 422, h: 237 });
  });

  test.each(PIP_CORNERS.map((c) => [c]))("%s stays inside the frame with the margin, every size, 16:9 and vertical", (corner) => {
    for (const out of [{ width: 1920, height: 1080 }, { width: 1080, height: 608 }, { width: 1080, height: 1920 }]) {
      for (const size of Object.values(PIP_SIZES)) {
        const r = pipRect(out, cam, pip(corner, size));
        const m = Math.round(out.width * 0.03);
        expect(r.w).toBe(Math.round(out.width * size));
        expect(Math.abs(r.h - (r.w * 9) / 16)).toBeLessThanOrEqual(0.5);
        expect(r.x === m).toBe(corner.endsWith("Left"));
        expect(r.x + r.w === out.width - m).toBe(corner.endsWith("Right"));
        expect(r.y === m).toBe(corner.startsWith("top"));
        expect(r.y + r.h === out.height - m).toBe(corner.startsWith("bottom"));
        expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= out.width && r.y + r.h <= out.height).toBe(true);
      }
    }
  });

  test("a 4:3 camera keeps its aspect", () => {
    expect(pipRect({ width: 1920, height: 1080 }, { width: 640, height: 480 }, pip("topLeft", 0.3))).toEqual({ x: 58, y: 58, w: 576, h: 432 });
  });
});

describe("cameraLayout", () => {
  const track = { file: "camera.mp4", offsetUs: 41_000, width: 1280, height: 720, fps: 30 };
  test("null without a camera or when hidden", () => {
    expect(cameraLayout(project(), { width: 1920, height: 1080 })).toBeNull();
    expect(cameraLayout(project(track, { ...DEFAULT_CAMERA_EDITS, visible: false }), { width: 1920, height: 1080 })).toBeNull();
  });
  test("defaults when edits.camera is missing: mirrored, bottom right", () => {
    expect(cameraLayout(project(track), { width: 1920, height: 1080 })).toEqual({ rect: { x: 1440, y: 785, w: 422, h: 237 }, mirror: true });
  });
  test("camera media time starts at its offset", () => {
    const p = project(track);
    expect(cameraMediaUs(p, 0)).toBe(0);
    expect(cameraMediaUs(p, 1_041_000)).toBe(1_000_000);
  });
});
