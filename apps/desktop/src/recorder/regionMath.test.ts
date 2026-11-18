import { describe, expect, it } from "vitest";
import { captureSize, dragRect, fpsCapped, fromNorm, meterLit, moveRect, presetFromDrag, presetPx, resizeRect, toCss, toNorm, toPhysical } from "./regionMath";

const MON = { width: 1440, height: 900 };
const ratio = (r: { w: number; h: number }) => r.w / r.h;

describe("dragRect", () => {
  it("gives a positive rect when dragged up and left", () => {
    expect(dragRect({ x: 500, y: 400 }, { x: 200, y: 100 }, MON)).toEqual({ x: 200, y: 100, w: 300, h: 300 });
  });

  it("clamps the rect to the bounds", () => {
    expect(dragRect({ x: 1300, y: 800 }, { x: 1600, y: 1000 }, MON)).toEqual({ x: 1300, y: 800, w: 140, h: 100 });
    expect(dragRect({ x: 100, y: 100 }, { x: -50, y: -20 }, MON)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("keeps 16:9 when locked, in any direction, inside the bounds", () => {
    const r = dragRect({ x: 800, y: 600 }, { x: 400, y: 100 }, MON, 16 / 9);
    expect(ratio(r)).toBeCloseTo(16 / 9, 6);
    expect(r.x + r.w).toBeCloseTo(800, 6);
    expect(r.y + r.h).toBeCloseTo(600, 6);
    const edge = dragRect({ x: 1300, y: 100 }, { x: 1440, y: 900 }, MON, 16 / 9);
    expect(edge.x + edge.w).toBeLessThanOrEqual(1440);
    expect(ratio(edge)).toBeCloseTo(16 / 9, 6);
  });
});

describe("resizeRect", () => {
  const r = { x: 240, y: 130, w: 960, h: 540 };

  it("resizes from a corner with aspect 16/9 and keeps the ratio and the opposite corner", () => {
    const out = resizeRect(r, "se", { x: 1000, y: 1000 }, MON, 16 / 9);
    expect(ratio(out)).toBeCloseTo(16 / 9, 6);
    expect(out.x).toBe(240);
    expect(out.y).toBe(130);
    const nw = resizeRect(r, "nw", { x: 600, y: 100 }, MON, 16 / 9);
    expect(ratio(nw)).toBeCloseTo(16 / 9, 6);
    expect(nw.x + nw.w).toBeCloseTo(1200, 6);
    expect(nw.y + nw.h).toBeCloseTo(670, 6);
  });

  it("moves one edge when free and clamps it to the bounds", () => {
    expect(resizeRect(r, "e", { x: 2000, y: 0 }, MON)).toEqual({ x: 240, y: 130, w: 1200, h: 540 });
    expect(resizeRect(r, "n", { x: 0, y: 300 }, MON)).toEqual({ x: 240, y: 300, w: 960, h: 370 });
    // dragged past the opposite edge: flips, stays positive
    expect(resizeRect(r, "w", { x: 1300, y: 0 }, MON)).toEqual({ x: 1200, y: 130, w: 100, h: 540 });
  });

  it("keeps the ratio from an edge handle when locked", () => {
    const out = resizeRect(r, "e", { x: 840, y: 0 }, MON, 16 / 9);
    expect(out.w).toBeCloseTo(600, 6);
    expect(ratio(out)).toBeCloseTo(16 / 9, 6);
    expect(out.y + out.h / 2).toBeCloseTo(400, 6); // vertical centre kept
  });
});

describe("moveRect", () => {
  it("moves inside the bounds only", () => {
    expect(moveRect({ x: 240, y: 130, w: 960, h: 540 }, 1000, -500, MON)).toEqual({ x: 480, y: 0, w: 960, h: 540 });
  });
});

describe("toNorm and fromNorm", () => {
  it("a full-screen rect is {0,0,1,1}", () => {
    expect(toNorm({ x: 0, y: 0, w: 1440, h: 900 }, MON)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("round-trips", () => {
    const n = toNorm({ x: 60, y: 280, w: 320, h: 180 }, { width: 960, height: 540 });
    const back = fromNorm(n, { width: 960, height: 540 });
    expect(back.x).toBeCloseTo(60, 9);
    expect(back.y).toBeCloseTo(280, 9);
    expect(back.w).toBeCloseTo(320, 9);
    expect(back.h).toBeCloseTo(180, 9);
  });
});

describe("presets", () => {
  const region = { x: 240, y: 130, w: 960, h: 540 };

  it("are drawn inside the region and stored normalized to the region, not the monitor", () => {
    const n = presetFromDrag({ x: 300, y: 410 }, { x: 620, y: 590 }, region);
    expect(n.x).toBeCloseTo(60 / 960, 6);
    expect(n.y).toBeCloseTo(280 / 540, 6);
    expect(n.w).toBeCloseTo(320 / 960, 6);
    expect(n.h).toBeCloseTo(180 / 540, 6);
    // a drag that leaves the region stays inside it
    const out = presetFromDrag({ x: 1000, y: 500 }, { x: 1400, y: 899 }, region);
    expect(out.x + out.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(out.y + out.h).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("keep the 16:9 output aspect in pixels, also in a region that is not 16:9", () => {
    const tall = { x: 100, y: 0, w: 600, h: 800 };
    const n = presetFromDrag({ x: 150, y: 50 }, { x: 450, y: 200 }, tall);
    const px = presetPx(n, tall);
    expect(ratio(px)).toBeCloseTo(16 / 9, 4);
    expect(px.x).toBeGreaterThanOrEqual(100);
  });

  it("move and scale with the region", () => {
    const n = presetFromDrag({ x: 300, y: 410 }, { x: 620, y: 590 }, region);
    const moved = presetPx(n, { x: 0, y: 0, w: 1920, h: 1080 });
    expect(moved.x).toBeCloseTo(120, 6);
    expect(moved.w).toBeCloseTo(640, 6);
  });
});

describe("physical pixels", () => {
  it("converts CSS to physical with the scale factor and back", () => {
    expect(toPhysical({ x: 240, y: 130, w: 960, h: 540 }, 1.5)).toEqual({ x: 360, y: 195, w: 1440, h: 810 });
    expect(toCss({ x: 360, y: 195, w: 1440, h: 810 }, 1.5)).toEqual({ x: 240, y: 130, w: 960, h: 540 });
  });
});

describe("meterLit", () => {
  it("maps the peak on -60..0 dB to 0..14 bars", () => {
    expect(meterLit(0)).toBe(0);
    expect(meterLit(0.0005)).toBe(0); // -66 dB
    expect(meterLit(1)).toBe(14);
    expect(meterLit(0.0316)).toBe(7); // -30 dB
  });
});

describe("fpsCapped", () => {
  it("is true above 2560 x 1440 physical pixels, as the engine's capture_fps", () => {
    expect(fpsCapped(2560, 1440)).toBe(false);
    expect(fpsCapped(1920, 1080)).toBe(false);
    expect(fpsCapped(3840, 2160)).toBe(true);
    expect(fpsCapped(3440, 1440)).toBe(true);
  });

  it("uses the region, or the monitor in Full screen", () => {
    const mon = { width: 3840, height: 2160 };
    expect(captureSize("full", { x: 0, y: 0, w: 1280, h: 720 }, mon)).toEqual({ width: 3840, height: 2160 });
    expect(captureSize("region", { x: 0, y: 0, w: 1280, h: 720 }, mon)).toEqual({ width: 1280, height: 720 });
  });
});
