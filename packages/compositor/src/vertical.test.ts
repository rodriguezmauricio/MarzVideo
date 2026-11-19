import { describe, expect, it } from "vitest";
import { parseProject, type MarzEvent } from "@marz/format";
import { CAMERA_SLOT_H, verticalBoxes, verticalCaptionArea, verticalFrameAt, verticalLayoutAt, VERTICAL_SIZE } from "./vertical";

const raw = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  id: "p",
  name: "P",
  createdAt: "2026-11-19T00:00:00Z",
  durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 30 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 30 },
  ...extra,
});
const cam = { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 };
const withCam = (edits: Record<string, unknown> = {}) =>
  parseProject(raw({ tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, camera: cam }, edits }));
const still = { x0: 0.5, moves: [] };

describe("verticalBoxes", () => {
  it("camera slot at the bottom or top, 1080 x 608; the screen takes the rest", () => {
    const b = verticalBoxes("pip", "bottom");
    expect(b.camera).toEqual({ x: 0, y: 1920 - CAMERA_SLOT_H, w: 1080, h: CAMERA_SLOT_H });
    expect(b.screen).toEqual({ x: 0, y: 0, w: 1080, h: 1920 - CAMERA_SLOT_H });
    expect(verticalBoxes("side", "top").camera!.y).toBe(0);
    expect(verticalBoxes("side", "top").screen.y).toBe(CAMERA_SLOT_H);
  });
  it("camera fullscreen and screen only", () => {
    expect(verticalBoxes("camera", "bottom").camera).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(verticalBoxes("screen", "bottom")).toEqual({ screen: { x: 0, y: 0, w: 1080, h: 1920 }, camera: null, radius: 0 });
  });
});

describe("verticalLayoutAt", () => {
  it("no camera: the screen fills the picture", () => {
    expect(verticalLayoutAt(parseProject(raw()), 0).screen).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });
  it("follows the scenes with vertical boxes and switches between them", () => {
    const p = withCam({
      camera: {
        visible: true,
        mirror: true,
        pip: { corner: "topRight", widthFrac: 0.22, marginFrac: 0.03, shape: "circle" },
        scenes: [{ id: "s", startUs: 4_000_000, endUs: 8_000_000, layout: "screen", origin: "manual" }],
      },
    });
    expect(verticalLayoutAt(p, 1_000_000).camera).toEqual({ x: 0, y: 0, w: 1080, h: CAMERA_SLOT_H });
    expect(verticalLayoutAt(p, 5_000_000).camera).toBeNull();
    const mid = verticalLayoutAt(p, 4_200_000);
    expect(mid.camera!.w).toBeGreaterThan(0);
    expect(mid.camera!.w).toBeLessThan(1080);
    expect(mid.screen.y).toBeGreaterThan(0);
    expect(mid.screen.y).toBeLessThan(CAMERA_SLOT_H);
  });
  it("the stored slot wins over the corner", () => {
    expect(verticalLayoutAt(withCam({ vertical: { cameraSlot: "top" } }), 0).camera!.y).toBe(0);
  });
  it("a hidden camera: screen only", () => {
    const p = withCam({ camera: { visible: false, mirror: true, pip: { corner: "bottomRight", widthFrac: 0.22, marginFrac: 0.03, shape: "rect" } } });
    expect(verticalLayoutAt(p, 0).camera).toBeNull();
  });
});

describe("verticalFrameAt", () => {
  it("fills the screen box with a window of its aspect around the aim; the cursor is mapped", () => {
    const ev: MarzEvent[] = [{ tUs: 0, type: "cursor", x: 960, y: 540 }];
    const { spec, crop } = verticalFrameAt(parseProject(raw()), ev, still, 1_000_000);
    expect(spec.dstRect.dx).toBeCloseTo(0, 6);
    expect(spec.dstRect.dw).toBeCloseTo(1080, 6);
    expect(spec.dstRect.dh).toBeCloseTo(1920, 6);
    expect(spec.srcRect.sh).toBeCloseTo(1080, 6);
    expect(spec.srcRect.sw).toBeCloseTo(607.5, 6);
    expect(crop.x + crop.w / 2).toBeCloseTo(0.5, 6);
    expect(spec.cursor!.x).toBeCloseTo(540, 6);
    expect(spec.cursor!.y).toBeCloseTo(960, 6);
  });
  it("his Frame block moves the window", () => {
    const p = parseProject(raw({ edits: { vertical: { holds: [{ id: "f", startUs: 0, endUs: 5_000_000, x: 0.2 }] } } }));
    const { crop } = verticalFrameAt(p, [], still, 2_000_000);
    expect(crop.x + crop.w / 2).toBeCloseTo(0.2, 6);
  });
});

describe("verticalCaptionArea", () => {
  it("the safe area without a camera", () => {
    const a = verticalCaptionArea(verticalBoxes("screen", "bottom"));
    expect(a.y).toBeCloseTo(1920 * 0.13, 6);
    expect(a.y + a.h).toBeCloseTo(1920 * 0.8, 6);
    expect(a.x).toBeCloseTo(1080 * 0.06, 6);
  });
  it("stays above a bottom camera slot and below a top one", () => {
    const b = verticalCaptionArea(verticalBoxes("pip", "bottom"));
    expect(b.y + b.h).toBeLessThanOrEqual(VERTICAL_SIZE.height - CAMERA_SLOT_H);
    const t = verticalCaptionArea(verticalBoxes("pip", "top"));
    expect(t.y).toBeGreaterThanOrEqual(CAMERA_SLOT_H);
  });
  it("camera fullscreen: the safe area", () => {
    expect(verticalCaptionArea(verticalBoxes("camera", "bottom")).y).toBeCloseTo(1920 * 0.13, 6);
  });
});
