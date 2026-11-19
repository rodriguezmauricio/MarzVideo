import { describe, expect, it } from "vitest";
import { parseProject, type MarzEvent } from "@marz/format";
import { backgroundPx, framedBox } from "./background";
import { frameAt } from "./frame";
import { layoutAt } from "./layout";
import { verticalFrameAt, VERTICAL_SIZE } from "./vertical";

const OUT = { width: 1920, height: 1080 };
const zoom = { id: "z", startUs: 2_000_000, endUs: 8_000_000, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, easeInUs: 0, easeOutUs: 0, easing: "linear", origin: "manual" };
const raw = (edits: Record<string, unknown> = {}, camera = false) =>
  parseProject({
    version: 1, id: "p", name: "P", createdAt: "2026-11-19T00:00:00Z", durationUs: 10_000_000,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, ...(camera ? { camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } } : {}) },
    output: { ...OUT, fps: 30 },
    edits,
  });
const on = (extra: Record<string, unknown> = {}) => ({ background: { style: "grid", ...extra } });
const close = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => {
  for (const k of ["x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(b[k], 3);
};

describe("backgroundPx", () => {
  it("off gives null", () => {
    expect(backgroundPx(raw(), OUT)).toBeNull();
  });
  it("margin, radius and shadow scale with the output's short side", () => {
    expect(backgroundPx(raw(on()), OUT)).toEqual({ style: "grid", pad: 64, radius: 16, shadow: { blur: 40, offsetY: 12, alpha: 0.5 } });
    expect(backgroundPx(raw(on({ padding: "L", corners: "square", shadow: false })), { width: 1280, height: 720 })).toEqual({ style: "grid", pad: 64, radius: 0, shadow: null });
    expect(backgroundPx(raw(on({ padding: "S" })), VERTICAL_SIZE)!.pad).toBe(40);
  });
});

describe("framedBox", () => {
  it("shrinks the box by the margin, never below a quarter of its size each side", () => {
    expect(framedBox(raw(on()), { x: 0, y: 0, w: 1920, h: 1080 }, OUT)).toEqual({ x: 64, y: 64, w: 1792, h: 952 });
    expect(framedBox(raw(on()), { x: 10, y: 10, w: 100, h: 80 }, OUT)).toEqual({ x: 30, y: 30, w: 60, h: 40 });
    expect(framedBox(raw(), { x: 0, y: 0, w: 1920, h: 1080 }, OUT)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});

describe("frameAt with a background", () => {
  it("off: no background, the screen fills the output as before", () => {
    const s = frameAt(raw(), [], 0);
    expect(s.background).toBeUndefined();
    expect(s.dstRect).toEqual({ dx: 0, dy: 0, dw: 1920, dh: 1080 });
  });

  it("on: the screen is fitted into the margin box at its own aspect", () => {
    const s = frameAt(raw(on()), [], 0);
    const w = (952 * 16) / 9;
    close(s.background!.frame, { x: 64 + (1792 - w) / 2, y: 64, w, h: 952 });
    expect(s.background!.style).toBe("grid");
    expect(s.background!.radius).toBe(16);
    expect(s.dstRect.dw).toBeCloseTo(w, 3);
    expect(s.dstRect.dy).toBe(64);
  });

  it("zooms happen inside the frame: the frame stays, the picture fills it", () => {
    const p = raw({ zooms: [zoom], ...on() });
    const rest = frameAt(p, [], 0);
    const zoomed = frameAt(p, [], 5_000_000);
    expect(zoomed.background!.frame).toEqual(rest.background!.frame);
    expect(zoomed.srcRect).toEqual({ sx: 480, sy: 270, sw: 960, sh: 540 });
    const f = zoomed.background!.frame;
    close({ x: zoomed.dstRect.dx, y: zoomed.dstRect.dy, w: zoomed.dstRect.dw, h: zoomed.dstRect.dh }, f);
  });

  it("the cursor maps into the frame", () => {
    const evs: MarzEvent[] = [{ tUs: 0, type: "cursor", x: 960, y: 540 }];
    const s = frameAt(raw(on()), evs, 0);
    expect(s.cursor!.x).toBeCloseTo(960, 3);
    expect(s.cursor!.y).toBeCloseTo(540, 3);
    const s2 = frameAt(raw(on()), [{ tUs: 0, type: "cursor", x: 0, y: 0 }], 0);
    expect(s2.cursor!.x).toBeCloseTo(s.background!.frame.x, 3);
    expect(s2.cursor!.y).toBe(64);
  });

  it("side column: the frame sits inside the layout's screen box", () => {
    const p = raw({ camera: { visible: true, mirror: true, pip: { corner: "bottomRight", widthFrac: 0.22, marginFrac: 0.03, shape: "rect" }, scenes: [{ id: "s", startUs: 0, endUs: 10_000_000, layout: "side", origin: "manual" }] }, ...on() }, true);
    const lay = layoutAt(p, 5_000_000, OUT);
    const s = frameAt(p, [], 5_000_000, lay.screen);
    const f = s.background!.frame;
    expect(f.x).toBeCloseTo(64, 3);
    expect(f.x + f.w).toBeCloseTo(lay.screen.w - 64, 3);
  });
});

describe("verticalFrameAt with a background", () => {
  const still = { x0: 0.5, moves: [] };
  it("the aimed window fills the margin box (no bars)", () => {
    const { spec } = verticalFrameAt(raw(on()), [], still, 0);
    expect(spec.background!.frame).toEqual({ x: 64, y: 64, w: 1080 - 128, h: 1920 - 128 });
    close({ x: spec.dstRect.dx, y: spec.dstRect.dy, w: spec.dstRect.dw, h: spec.dstRect.dh }, spec.background!.frame);
  });
  it("off: as before", () => {
    const { spec } = verticalFrameAt(raw(), [], still, 0);
    expect(spec.background).toBeUndefined();
    expect(spec.dstRect).toEqual({ dx: 0, dy: 0, dw: 1080, dh: 1920 });
  });
});
