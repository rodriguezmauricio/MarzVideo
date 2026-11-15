import { describe, expect, test } from "vitest";
import type { Rect, Zoom } from "@marz/format";
import { clampRect, ease, FULL_RECT, lockAspect, zoomRectAt } from "./zoom";

const rect: Rect = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
const zoom = (over: Partial<Zoom> = {}): Zoom => ({
  id: "z",
  startUs: 2_000_000,
  endUs: 8_000_000,
  rect,
  easeInUs: 1_000_000,
  easeOutUs: 1_000_000,
  easing: "linear",
  origin: "manual",
  ...over,
});

describe("zoomRectAt", () => {
  test("full rect before any zoom", () => {
    expect(zoomRectAt([zoom()], 1_000_000)).toEqual(FULL_RECT);
    expect(zoomRectAt([], 5)).toEqual(FULL_RECT);
  });

  test("equals the zoom rect at the midpoint", () => {
    expect(zoomRectAt([zoom()], 5_000_000)).toEqual(rect);
  });

  test("halfway through ease in (linear)", () => {
    const r = zoomRectAt([zoom()], 2_500_000);
    expect(r.x).toBeCloseTo(0.1);
    expect(r.w).toBeCloseTo(0.75);
  });

  test("ease in finishes exactly at start + easeInUs", () => {
    expect(zoomRectAt([zoom()], 3_000_000)).toEqual(rect);
  });

  test("halfway through ease out (linear)", () => {
    const r = zoomRectAt([zoom()], 7_500_000);
    expect(r.w).toBeCloseTo(0.75);
  });

  test("full rect again at and after the end", () => {
    expect(zoomRectAt([zoom()], 8_000_000)).toEqual(FULL_RECT);
    expect(zoomRectAt([zoom()], 9_000_000)).toEqual(FULL_RECT);
  });

  test("a zoom with end <= start is ignored", () => {
    expect(zoomRectAt([zoom({ startUs: 5_000_000, endUs: 5_000_000 })], 5_000_000)).toEqual(FULL_RECT);
    expect(zoomRectAt([zoom({ startUs: 6_000_000, endUs: 4_000_000 })], 5_000_000)).toEqual(FULL_RECT);
  });

  test("when zooms overlap the later start wins", () => {
    const other: Rect = { x: 0, y: 0, w: 0.25, h: 0.25 };
    const zs = [zoom({ id: "a" }), zoom({ id: "b", startUs: 4_000_000, endUs: 9_000_000, rect: other })];
    expect(zoomRectAt(zs, 6_000_000)).toEqual(other);
  });

  test("short zoom shorter than both eases never exceeds its rect", () => {
    const r = zoomRectAt([zoom({ startUs: 0, endUs: 1_000_000, easeInUs: 800_000, easeOutUs: 800_000 })], 500_000);
    expect(r.w).toBeGreaterThanOrEqual(rect.w);
    expect(r.w).toBeLessThanOrEqual(1);
  });
});

describe("ease", () => {
  test("easeInOutCubic endpoints and midpoint", () => {
    expect(ease("easeInOutCubic", 0)).toBe(0);
    expect(ease("easeInOutCubic", 0.5)).toBe(0.5);
    expect(ease("easeInOutCubic", 1)).toBe(1);
  });
  test("linear is identity and input is clamped", () => {
    expect(ease("linear", 0.3)).toBeCloseTo(0.3);
    expect(ease("linear", -1)).toBe(0);
    expect(ease("linear", 2)).toBe(1);
  });
});

describe("clampRect", () => {
  test("keeps the rect inside the unit square", () => {
    const r = clampRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });
  test("enforces a minimum size and non-negative origin", () => {
    const r = clampRect({ x: -0.3, y: -0.3, w: 0.001, h: 0.001 });
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.w).toBeGreaterThanOrEqual(0.05);
    expect(r.h).toBeGreaterThanOrEqual(0.05);
  });
});

describe("lockAspect", () => {
  test("16:9 source with 16:9 aspect gives w === h in normalized units", () => {
    const r = lockAspect({ x: 0.2, y: 0.2, w: 0.5, h: 0.3 }, 16 / 9, { width: 1920, height: 1080 });
    expect(r.w).toBeCloseTo(r.h);
    expect(r.x + r.w / 2).toBeCloseTo(0.45);
    expect(r.y + r.h / 2).toBeCloseTo(0.35);
  });
  test("result stays inside the unit square", () => {
    const r = lockAspect({ x: 0.7, y: 0.7, w: 0.6, h: 0.1 }, 16 / 9, { width: 1920, height: 1080 });
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
  });
});
