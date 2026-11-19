import { describe, expect, test } from "vitest";
import { parseProject, type Corner, type LayoutKind, type Pip } from "@marz/format";
import { coverCrop, layoutAt, LAYOUT_SWITCH_US, staticLayout } from "./layout";
import { frameAt } from "./frame";

const OUT = { width: 1920, height: 1080 };
const CAM = { width: 1280, height: 720 };
const pip = (shape = "rect", corner: Corner = "bottomRight"): Pip => ({ corner, widthFrac: 0.22, marginFrac: 0.03, shape });

const project = (camera?: object, withCam = true) =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, ...(withCam ? { camera: { file: "camera.mp4", offsetUs: 0, ...CAM, fps: 30 } } : {}) },
    output: { ...OUT, fps: 60 },
    edits: { zooms: [], cuts: [], ...(camera ? { camera } : {}) },
  });
const scene = (id: string, startUs: number, endUs: number, layout: LayoutKind) => ({ id, startUs, endUs, layout, origin: "manual" });
const cam = (scenes: object[] = [], extra: object = {}) => ({ visible: true, mirror: true, pip: pip(), scenes, ...extra });
const FULL = { x: 0, y: 0, w: 1920, h: 1080 };

describe("staticLayout", () => {
  test("corner bubble, plain: today's picture-in-picture, full screen", () => {
    const s = staticLayout("pip", OUT, CAM, pip());
    expect(s.screen).toEqual(FULL);
    expect(s.camera).toEqual({ x: 1440, y: 785, w: 422, h: 237 });
    expect(s.radius).toBe(0);
  });

  test("rounded keeps the box, radius 18% of the short side", () => {
    const s = staticLayout("pip", OUT, CAM, pip("rounded"));
    expect(s.camera).toEqual({ x: 1440, y: 785, w: 422, h: 237 });
    expect(s.radius).toBe(Math.round(237 * 0.18));
  });

  test("circle and square: a square box 75% of the bubble width, in the corner with the margin", () => {
    for (const shape of ["circle", "square"]) {
      const s = staticLayout("pip", OUT, CAM, pip(shape, "topLeft"));
      const side = Math.round(1920 * 0.22 * 0.75);
      expect(s.camera).toEqual({ x: 58, y: 58, w: side, h: side });
      expect(s.radius).toBe(shape === "circle" ? side / 2 : 0);
    }
  });

  test("an unknown shape draws as plain", () => {
    expect(staticLayout("pip", OUT, CAM, pip("hexagon"))).toEqual(staticLayout("pip", OUT, CAM, pip()));
  });

  test("side column: full height 9:16 panel on the corner's side, screen in the rest", () => {
    const r = staticLayout("side", OUT, CAM, pip());
    expect(r.camera).toEqual({ x: 1920 - 608, y: 0, w: 608, h: 1080 });
    expect(r.screen).toEqual({ x: 0, y: 0, w: 1312, h: 1080 });
    const l = staticLayout("side", OUT, CAM, pip("rect", "topLeft"));
    expect(l.camera).toEqual({ x: 0, y: 0, w: 608, h: 1080 });
    expect(l.screen).toEqual({ x: 608, y: 0, w: 1312, h: 1080 });
    expect(r.radius).toBe(0);
  });

  test("side column ignores the bubble's mask", () => {
    expect(staticLayout("side", OUT, CAM, pip("circle")).radius).toBe(0);
  });

  test("camera fullscreen and screen only", () => {
    expect(staticLayout("camera", OUT, CAM, pip("circle"))).toEqual({ screen: FULL, camera: FULL, radius: 0 });
    expect(staticLayout("screen", OUT, CAM, pip())).toEqual({ screen: FULL, camera: null, radius: 0 });
  });
});

describe("layoutAt", () => {
  test("no camera track: screen only", () => {
    expect(layoutAt(project(undefined, false), 0, OUT)).toEqual({ screen: FULL, camera: null, radius: 0 });
  });

  test("no edits: today's bubble everywhere", () => {
    expect(layoutAt(project(), 5_000_000, OUT).camera).toEqual({ x: 1440, y: 785, w: 422, h: 237 });
  });

  test("camera hidden: screen only, scenes too", () => {
    const p = project(cam([scene("a", 1_000_000, 5_000_000, "camera")], { visible: false }));
    expect(layoutAt(p, 3_000_000, OUT).camera).toBeNull();
  });

  test("inside a scene after the switch: that layout", () => {
    const p = project(cam([scene("a", 1_000_000, 5_000_000, "side")]));
    expect(layoutAt(p, 3_000_000, OUT)).toEqual(staticLayout("side", OUT, CAM, pip()));
    expect(layoutAt(p, 6_000_000, OUT)).toEqual(staticLayout("pip", OUT, CAM, pip()));
  });

  test("a switch eases over 400 ms from the boundary, symmetric at the middle", () => {
    const p = project(cam([scene("a", 1_000_000, 5_000_000, "camera")]));
    const from = staticLayout("pip", OUT, CAM, pip()).camera!;
    expect(layoutAt(p, 1_000_000, OUT).camera).toEqual(from);
    const mid = layoutAt(p, 1_000_000 + LAYOUT_SWITCH_US / 2, OUT).camera!;
    expect(mid.x).toBeCloseTo((from.x + 0) / 2, 5);
    expect(mid.w).toBeCloseTo((from.w + 1920) / 2, 5);
    const early = layoutAt(p, 1_000_000 + LAYOUT_SWITCH_US / 10, OUT).camera!;
    expect(early.w - from.w).toBeLessThan((1920 - from.w) * 0.1); // eased: slow start
    expect(layoutAt(p, 1_000_000 + LAYOUT_SWITCH_US, OUT).camera).toEqual(FULL);
  });

  test("the screen moves with the side column", () => {
    const p = project(cam([scene("a", 1_000_000, 5_000_000, "side")]));
    const s = layoutAt(p, 1_000_000 + LAYOUT_SWITCH_US / 2, OUT).screen;
    expect(s.w).toBeCloseTo((1920 + 1312) / 2, 5);
  });

  test("going to screen only shrinks the camera to the centre of its box", () => {
    const p = project(cam([scene("a", 1_000_000, 5_000_000, "screen")]));
    const b = staticLayout("pip", OUT, CAM, pip()).camera!;
    const mid = layoutAt(p, 1_000_000 + LAYOUT_SWITCH_US / 2, OUT).camera!;
    expect(mid.x + mid.w / 2).toBeCloseTo(b.x + b.w / 2, 5);
    expect(mid.w).toBeCloseTo(b.w / 2, 5);
    expect(layoutAt(p, 1_000_000 + LAYOUT_SWITCH_US, OUT).camera).toBeNull();
  });

  test("the side column slides in from its edge", () => {
    const p = project(cam([scene("a", 1_000_000, 5_000_000, "screen"), scene("b", 5_000_000, 9_000_000, "side")]));
    const mid = layoutAt(p, 5_000_000 + LAYOUT_SWITCH_US / 2, OUT).camera!;
    expect(mid.w).toBe(608);
    expect(mid.x).toBeCloseTo((1920 + 1312) / 2, 5);
  });

  test("radius moves from circle to square corners", () => {
    const p = project(cam([scene("a", 1_000_000, 5_000_000, "camera")], { pip: pip("circle") }));
    const r0 = staticLayout("pip", OUT, CAM, pip("circle")).radius;
    expect(layoutAt(p, 1_000_000 + LAYOUT_SWITCH_US / 2, OUT).radius).toBeCloseTo(r0 / 2, 5);
  });

  test("a switch inside a switch starts from where the first one is", () => {
    const p = project(cam([scene("a", 1_000_000, 1_200_000, "camera"), scene("b", 1_200_000, 5_000_000, "screen")]));
    const at = layoutAt(p, 1_200_000, OUT);
    const halfway = layoutAt(project(cam([scene("a", 1_000_000, 5_000_000, "camera")])), 1_200_000, OUT);
    expect(at).toEqual(halfway);
  });

  test("a scene at 0 does not animate in", () => {
    const p = project(cam([scene("a", 0, 5_000_000, "camera")]));
    expect(layoutAt(p, 0, OUT).camera).toEqual(FULL);
  });

  test("overlapping scenes: the later start wins", () => {
    const p = project(cam([scene("a", 1_000_000, 8_000_000, "camera"), scene("b", 3_000_000, 5_000_000, "screen")]));
    expect(layoutAt(p, 4_000_000, OUT).camera).toBeNull();
    expect(layoutAt(p, 7_000_000, OUT).camera).toEqual(FULL);
  });
});

describe("coverCrop", () => {
  test("16:9 camera in a 9:16 box: centre slice of the width", () => {
    const c = coverCrop(CAM, { x: 0, y: 0, w: 608, h: 1080 });
    expect(c.sh).toBe(720);
    expect(c.sw).toBeCloseTo((720 * 608) / 1080, 5);
    expect(c.sx).toBeCloseTo((1280 - c.sw) / 2, 5);
  });
  test("same aspect: the whole picture", () => {
    expect(coverCrop(CAM, { x: 0, y: 0, w: 1920, h: 1080 })).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });
  test("square box: centre square", () => {
    expect(coverCrop(CAM, { x: 0, y: 0, w: 100, h: 100 })).toEqual({ sx: 280, sy: 0, sw: 720, sh: 720 });
  });
});

describe("frameAt with a screen box", () => {
  test("the screen is fitted inside the box, cursor follows", () => {
    const p = project();
    const events = [{ type: "cursor" as const, tUs: 0, x: 960, y: 540 }];
    const f = frameAt(p, events, 1000, { x: 0, y: 0, w: 1312, h: 1080 });
    expect(f.dstRect.dx).toBe(0);
    expect(f.dstRect.dw).toBe(1312);
    expect(f.dstRect.dh).toBeCloseTo(1312 * 9 / 16, 5);
    expect(f.dstRect.dy).toBeCloseTo((1080 - 1312 * 9 / 16) / 2, 5);
    expect(f.cursor!.x).toBeCloseTo(656, 5);
    expect(f.cursor!.y).toBeCloseTo(540, 5);
  });
  test("the box is offset", () => {
    const f = frameAt(project(), [], 0, { x: 608, y: 0, w: 1312, h: 1080 });
    expect(f.dstRect.dx).toBe(608);
  });
});
