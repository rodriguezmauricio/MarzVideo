import { describe, expect, test } from "vitest";
import { parseProject, type Corner, type LayoutKind, type Pip } from "@marz/format";
import { layoutAt, staticLayout } from "./layout";
import { MORPH_POINTS, starPolygon } from "./masks";
import { verticalBoxes, verticalLayoutAt } from "./vertical";

const OUT = { width: 1920, height: 1080 };
const CAM = { width: 1280, height: 720 };
const pip = (shape = "rect", corner: Corner = "bottomRight"): Pip => ({ corner, widthFrac: 0.22, marginFrac: 0.03, shape });
const project = (camera: object) =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, camera: { file: "camera.mp4", offsetUs: 0, ...CAM, fps: 30 } },
    output: { ...OUT, fps: 60 },
    edits: { zooms: [], cuts: [], camera },
  });
const scene = (id: string, startUs: number, endUs: number, layout: LayoutKind) => ({ id, startUs, endUs, layout, origin: "manual" });
const cam = (scenes: object[], extra: object = {}, shape = "rect") => ({ visible: true, mirror: true, pip: pip(shape), scenes, ...extra });
const centre = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

describe("floating 9:16", () => {
  test("80% of the height, 9:16, the margin from the corner's side, centred vertically, screen full", () => {
    const s = staticLayout("float", OUT, CAM, pip());
    expect(s.camera).toEqual({ x: 1920 - 58 - 486, y: 108, w: 486, h: 864 });
    expect(s.screen).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(s.radius).toBe(0);
    expect(staticLayout("float", OUT, CAM, pip("rect", "topLeft")).camera!.x).toBe(58);
  });

  test("any shape but plain gives the panel round corners", () => {
    for (const shape of ["rounded", "circle", "star", "custom"]) expect(staticLayout("float", OUT, CAM, pip(shape)).radius).toBe(Math.round(486 * 0.18));
  });

  test("it slides in from its edge", () => {
    const p = project(cam([scene("a", 2_000_000, 8_000_000, "float")], {}, "rect"));
    // Linear-free check: just after the switch starts the panel is mostly off the right edge, same size.
    const s = layoutAt({ ...p, edits: { ...p.edits, camera: { ...p.edits.camera!, scenes: [] } } }, 0, OUT);
    expect(s.camera).not.toBeNull();
    const early = layoutAt(project(cam([scene("a", 2_000_000, 8_000_000, "screen"), scene("b", 8_000_000, 12_000_000, "float")])), 8_050_000, OUT);
    expect(early.camera!.w).toBeCloseTo(486, 0);
    expect(early.camera!.x).toBeGreaterThan(1920 - 58 - 486);
  });

  test("vertical: the float panel uses the camera slot", () => {
    expect(verticalBoxes("float", "bottom")).toEqual(verticalBoxes("side", "bottom"));
  });
});

describe("star and custom masks", () => {
  test("star: the circle's square box with the star outline", () => {
    const s = staticLayout("pip", OUT, CAM, pip("star"));
    const side = Math.round(1920 * 0.22 * 0.75);
    expect(s.camera).toEqual({ x: 1920 - 58 - side, y: 1080 - 58 - side, w: side, h: side });
    expect(s.mask).toEqual(starPolygon());
  });

  test("custom: the imported outline; without one it draws as a circle", () => {
    const tri = [0.5, 0, 1, 1, 0, 1];
    expect(staticLayout("pip", OUT, CAM, pip("custom"), tri).mask).toEqual(tri);
    const none = staticLayout("pip", OUT, CAM, pip("custom"));
    expect(none.mask).toBeUndefined();
    expect(none.radius).toBe(none.camera!.w / 2);
    const p = project(cam([], { customMask: { name: "tri.svg", points: tri } }, "custom"));
    expect(layoutAt(p, 1_000_000, OUT).mask).toEqual(tri);
  });

  test("plain shapes carry no outline (drawn with the radius as before)", () => {
    expect(staticLayout("pip", OUT, CAM, pip("circle")).mask).toBeUndefined();
  });
});

describe("switch presets", () => {
  const sw = (t: object) => ({ transitions: [{ from: "pip", to: "side", ...t }] });
  const at = (extra: object, t: number) => layoutAt(project(cam([scene("a", 4_000_000, 10_000_000, "side")], extra)), t, OUT);
  const pipBox = staticLayout("pip", OUT, CAM, pip()).camera!;
  const sideBox = staticLayout("side", OUT, CAM, pip()).camera!;

  test("default: done after 0.4 s", () => {
    expect(at({}, 4_450_000).camera).toEqual(sideBox);
  });

  test("a 1.2 s switch is still moving at 0.6 s and done at 1.2 s", () => {
    const mid = at(sw({ durationUs: 1_200_000, easing: "linear", morph: "blend" }), 4_600_000).camera!;
    expect(mid.w).toBeCloseTo((pipBox.w + sideBox.w) / 2, 5);
    expect(at(sw({ durationUs: 1_200_000, easing: "linear", morph: "blend" }), 5_200_000).camera).toEqual(sideBox);
  });

  test("easing: in is behind linear, out is ahead of it", () => {
    const lin = at(sw({ durationUs: 800_000, easing: "linear" }), 4_200_000).camera!.w;
    const inn = at(sw({ durationUs: 800_000, easing: "easeInCubic" }), 4_200_000).camera!.w;
    const out = at(sw({ durationUs: 800_000, easing: "easeOutCubic" }), 4_200_000).camera!.w;
    const grow = sideBox.w > pipBox.w ? 1 : -1;
    expect((inn - lin) * grow).toBeLessThan(0);
    expect((out - lin) * grow).toBeGreaterThan(0);
  });

  test("path: the centre follows the curve, bent across the straight line", () => {
    const v = -0.5;
    const s = at(sw({ durationUs: 800_000, easing: "linear", path: { c1: [1 / 3, v], c2: [2 / 3, v] } }), 4_400_000).camera!;
    const a = centre(pipBox), b = centre(sideBox);
    const d = { x: b.x - a.x, y: b.y - a.y };
    const perp = { x: -d.y, y: d.x };
    // Cubic at t = 0.5 with both controls at v across: 0.75 v of the perpendicular off the midpoint.
    const want = { x: (a.x + b.x) / 2 + 0.75 * v * perp.x, y: (a.y + b.y) / 2 + 0.75 * v * perp.y };
    expect(centre(s).x).toBeCloseTo(want.x, 3);
    expect(centre(s).y).toBeCloseTo(want.y, 3);
  });

  test("morph at end: start size during the first 70%, then the size blends", () => {
    const e = { durationUs: 1_000_000, easing: "linear", morph: "end" };
    const s = at(sw(e), 4_350_000).camera!;
    expect(s.w).toBeCloseTo(pipBox.w, 5);
    expect(s.h).toBeCloseTo(pipBox.h, 5);
    const c = centre(s), a = centre(pipBox), b = centre(sideBox);
    expect(c.x).toBeCloseTo(a.x + (b.x - a.x) * 0.5, 3);
    const late = at(sw(e), 4_850_000).camera!;
    expect(late.w).toBeCloseTo((pipBox.w + sideBox.w) / 2, 3);
    expect(centre(late).x).toBeCloseTo(b.x, 3);
  });

  test("a star morphs into the side column outline by points", () => {
    const p = project(cam([scene("a", 4_000_000, 10_000_000, "side")], {}, "star"));
    const mid = layoutAt(p, 4_200_000, OUT);
    expect(mid.mask!.length).toBe(MORPH_POINTS * 2);
    expect(layoutAt(p, 4_500_000, OUT).mask).toBeUndefined();
  });

  test("vertical uses the same length and easing", () => {
    const p = project(cam([scene("a", 4_000_000, 10_000_000, "camera")], { transitions: [{ from: "pip", to: "camera", durationUs: 1_200_000, easing: "linear", morph: "blend" }] }));
    const v0 = verticalLayoutAt(p, 3_900_000).camera!;
    const v1 = verticalLayoutAt(p, 5_300_000).camera!;
    const mid = verticalLayoutAt(p, 4_600_000).camera!;
    expect(mid.h).toBeCloseTo((v0.h + v1.h) / 2, 5);
  });
});
