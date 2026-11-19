import { describe, expect, test } from "vitest";
import { lerpPolygon, MORPH_POINTS, parseSvgMask, polygonArea, resamplePolygon, roundRectPolygon, starPolygon } from "./masks";

const bbox = (pts: number[]) => {
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe("star", () => {
  test("ten points, one point up, fits the unit box with its aspect, centred", () => {
    const s = starPolygon();
    expect(s.length).toBe(20);
    expect(s[0]).toBeCloseTo(0.5);
    expect(s[1]).toBeCloseTo(bbox(s).y0); // the top point
    const b = bbox(s);
    expect(Math.max(b.x1 - b.x0, b.y1 - b.y0)).toBeCloseTo(1);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(0.5);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(0.5);
    expect(polygonArea(s)).toBeGreaterThan(0); // clockwise on screen
  });
});

describe("resample", () => {
  test("n points by length, starting at the top centre, clockwise", () => {
    // A counter-clockwise square starting at the bottom left.
    const sq = [0, 1, 1, 1, 1, 0, 0, 0];
    const r = resamplePolygon(sq, 8);
    expect(r.length).toBe(16);
    expect(r[0]).toBeCloseTo(0.5);
    expect(r[1]).toBeCloseTo(0);
    expect(r[2]).toBeCloseTo(1); // next point: the top right corner (clockwise)
    expect(r[3]).toBeCloseTo(0);
    expect(polygonArea(r)).toBeGreaterThan(0);
  });

  test("round rect polygon: square corners at radius 0, a circle-ish outline at half the side", () => {
    const sq = roundRectPolygon(100, 50, 0);
    const b = bbox(sq);
    expect([b.x0, b.y0, b.x1, b.y1]).toEqual([0, 0, 1, 1]);
    const c = resamplePolygon(roundRectPolygon(100, 100, 50), 64);
    for (let i = 0; i < c.length; i += 2) expect(Math.hypot(c[i]! - 0.5, c[i + 1]! - 0.5)).toBeCloseTo(0.5, 1);
  });

  test("lerp moves each point straight to its partner", () => {
    const a = resamplePolygon(starPolygon(), MORPH_POINTS);
    const b = resamplePolygon(roundRectPolygon(10, 10, 0), MORPH_POINTS);
    expect(lerpPolygon(a, b, 0)).toEqual(a);
    expect(lerpPolygon(a, b, 1)).toEqual(b);
    expect(lerpPolygon(a, b, 0.5)[0]).toBeCloseTo((a[0]! + b[0]!) / 2);
  });
});

describe("SVG import", () => {
  test("a triangle path: normalized into the unit box, aspect kept, centred", () => {
    const r = parseSvgMask('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path d="M 0 100 L 100 0 L 200 100 Z"/></svg>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = bbox(r.points);
    expect(b.x0).toBeCloseTo(0);
    expect(b.x1).toBeCloseTo(1);
    expect(b.y0).toBeCloseTo(0.25);
    expect(b.y1).toBeCloseTo(0.75);
    expect(r.points.length).toBe(6);
  });

  test("relative commands, curves and arcs flatten to a closed outline", () => {
    const heart = '<svg><path d="m12 21-1.5-1.3C5.4 15.4 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.9-8.5 11.5z"/></svg>';
    const r = parseSvgMask(heart);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points.length / 2).toBeGreaterThan(20);
    expect(r.points.length / 2).toBeLessThanOrEqual(512);
    for (const v of r.points) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const circle = parseSvgMask('<svg><path d="M 10 50 A 40 40 0 1 1 90 50 A 40 40 0 1 1 10 50 Z"/></svg>');
    expect(circle.ok).toBe(true);
    if (!circle.ok) return;
    for (let i = 0; i < circle.points.length; i += 2) expect(Math.hypot(circle.points[i]! - 0.5, circle.points[i + 1]! - 0.5)).toBeCloseTo(0.5, 1);
  });

  test("a polygon element works too", () => {
    const r = parseSvgMask('<svg><polygon points="0,0 10,0 10,10 0,10"/></svg>');
    expect(r.ok).toBe(true);
  });

  test("refuses two shapes, an open path, no path, scripts are never needed", () => {
    expect(parseSvgMask('<svg><path d="M0 0 L1 0 L1 1 Z"/><path d="M0 0 L1 0 L1 1 Z"/></svg>').ok).toBe(false);
    expect(parseSvgMask('<svg><path d="M0 0 L1 0 L1 1 Z M5 5 L6 5 L6 6 Z"/></svg>').ok).toBe(false);
    expect(parseSvgMask('<svg><path d="M0 0 L10 0 L10 10"/></svg>').ok).toBe(false);
    expect(parseSvgMask("<svg><rect width='10' height='10'/></svg>").ok).toBe(false);
    expect(parseSvgMask("not svg at all").ok).toBe(false);
    expect(parseSvgMask('<svg><path d="M0 0 L10 0 L0 0 Z"/></svg>').ok).toBe(false); // no area
  });
});
