import { describe, expect, test } from "vitest";
import type { Pip } from "@marz/format";
import { bubbleBox } from "./layout";
import { dropPip, resizeBubble, SNAP_FRAC } from "./pipPlace";

const OUT = { width: 1920, height: 1080 };
const CAM = { width: 1280, height: 720 };
const pip: Pip = { corner: "bottomRight", widthFrac: 0.22, marginFrac: 0.03, shape: "rect" };

describe("bubbleBox with a free position", () => {
  test("no x/y: the corner as before", () => {
    expect(bubbleBox(OUT, CAM, pip).box).toEqual({ x: 1440, y: 785, w: 422, h: 237 });
  });
  test("x/y: left and top as shares of the output", () => {
    expect(bubbleBox(OUT, CAM, { ...pip, x: 0.5, y: 0.25 }).box).toEqual({ x: 960, y: 270, w: 422, h: 237 });
  });
  test("kept inside the frame", () => {
    expect(bubbleBox(OUT, CAM, { ...pip, x: 0.95, y: 0.99 }).box).toEqual({ x: 1920 - 422, y: 1080 - 237, w: 422, h: 237 });
  });
  test("circle: a square box at the free position, radius half the side", () => {
    const b = bubbleBox(OUT, CAM, { ...pip, shape: "circle", x: 0.1, y: 0.1 });
    expect(b.box).toEqual({ x: 192, y: 108, w: 317, h: 317 });
    expect(b.radius).toBe(158.5);
  });
});

describe("dropPip", () => {
  test("near a corner it snaps there and drops x/y", () => {
    const corner = bubbleBox(OUT, CAM, { ...pip, corner: "topLeft" }).box;
    const near = { ...corner, x: corner.x + 20, y: corner.y + 30 };
    const out = dropPip(pip, near, OUT, CAM);
    expect(out).toEqual({ corner: "topLeft", widthFrac: 0.22, marginFrac: 0.03, shape: "rect" });
    expect("x" in out).toBe(false);
  });
  test("elsewhere it stays free, with the nearest corner for the side column", () => {
    const out = dropPip(pip, { x: 300, y: 600, w: 422, h: 237 }, OUT, CAM);
    expect(out.corner).toBe("bottomLeft");
    expect(out.x).toBeCloseTo(300 / 1920, 4);
    expect(out.y).toBeCloseTo(600 / 1080, 4);
  });
  test("snap distance is 4% of the output width", () => {
    expect(SNAP_FRAC).toBe(0.04);
    const corner = bubbleBox(OUT, CAM, pip).box;
    expect(dropPip(pip, { ...corner, x: corner.x - 76 }, OUT, CAM).x).toBeUndefined();
    expect(dropPip(pip, { ...corner, x: corner.x - 78 }, OUT, CAM).x).toBeDefined();
  });
  test("a resized bubble keeps its new size", () => {
    const out = dropPip(pip, { x: 500, y: 500, w: 576, h: 324 }, OUT, CAM);
    expect(out.widthFrac).toBeCloseTo(0.3, 4);
  });
  test("circle: widthFrac from the square side", () => {
    const c = { ...pip, shape: "circle" };
    const out = dropPip(c, { x: 500, y: 500, w: 432, h: 432 }, OUT, CAM);
    expect(out.widthFrac).toBeCloseTo(0.3, 4);
  });
});

describe("resizeBubble", () => {
  const box = { x: 1000, y: 500, w: 400, h: 225 };
  test("the opposite corner stays, the aspect is kept", () => {
    const r = resizeBubble(box, "se", { x: 1600, y: 0 }, OUT);
    expect(r.x).toBe(1000);
    expect(r.y).toBe(500);
    expect(r.w).toBe(600);
    expect(r.h).toBeCloseTo(337.5, 3);
  });
  test("nw anchors the bottom right", () => {
    const r = resizeBubble(box, "nw", { x: 900, y: 0 }, OUT);
    expect(r.x + r.w).toBe(1400);
    expect(r.y + r.h).toBeCloseTo(725, 3);
    expect(r.w).toBe(500);
  });
  test("clamped to 8% and 60% of the width and to the frame", () => {
    expect(resizeBubble(box, "se", { x: 1001, y: 0 }, OUT).w).toBeCloseTo(0.08 * 1920, 3);
    const big = resizeBubble(box, "se", { x: 5000, y: 0 }, OUT);
    expect(big.x + big.w).toBeLessThanOrEqual(1920);
    expect(big.y + big.h).toBeLessThanOrEqual(1080);
  });
});

describe("pipAtBox", () => {
  test("free at the box, no snapping, size from the box", async () => {
    const { pipAtBox } = await import("./pipPlace");
    const corner = bubbleBox(OUT, CAM, pip).box;
    const p = pipAtBox(pip, corner, OUT);
    expect(p.x).toBeCloseTo(1440 / 1920, 4);
    expect(p.widthFrac).toBe(0.22);
    expect(bubbleBox(OUT, CAM, p).box).toEqual(corner);
  });
});
