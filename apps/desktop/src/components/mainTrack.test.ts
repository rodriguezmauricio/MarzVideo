import { describe, expect, test } from "vitest";
import { MAIN_TRACK, packRows, rowGeometry } from "./mainTrack";

const it = (id: string, startUs: number, endUs: number) => ({ id, startUs, endUs });

describe("packRows", () => {
  test("blocks that do not overlap share row 0", () => {
    const r = packRows([it("a", 0, 10), it("b", 10, 20), it("c", 30, 40)]);
    expect(r.rows).toBe(1);
    expect([...r.row.values()]).toEqual([0, 0, 0]);
  });

  test("overlapping blocks go to the first free row, earlier start first", () => {
    const r = packRows([it("late", 5, 15), it("a", 0, 10), it("b", 2, 4), it("c", 12, 20)]);
    expect(r.row.get("a")).toBe(0);
    expect(r.row.get("b")).toBe(1);
    expect(r.row.get("late")).toBe(1);
    expect(r.row.get("c")).toBe(0);
    expect(r.rows).toBe(2);
  });

  test("no items: one row", () => {
    expect(packRows([]).rows).toBe(1);
  });

  test("the dragged block keeps its row while it moves (rows come from the stored ranges)", () => {
    const r = packRows([it("a", 0, 10), it("b", 5, 15)]);
    expect(r.row.get("b")).toBe(1);
  });
});

describe("rowGeometry", () => {
  test("one row: 34px at most, 6px from the top", () => {
    expect(rowGeometry(0, 1)).toEqual({ top: 6, height: 34 });
  });
  test("rows share the track, 4px apart", () => {
    const g = rowGeometry(2, 3);
    const h = (MAIN_TRACK - 12 - 8) / 3;
    expect(g.height).toBeCloseTo(h);
    expect(g.top).toBeCloseTo(6 + 2 * (h + 4));
  });
});
