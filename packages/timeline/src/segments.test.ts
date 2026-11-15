import { describe, expect, test } from "vitest";
import type { Cut } from "@marz/format";
import { keptSegments, outputDurationUs, outputToSource, sourceToOutput } from "./segments";

const cut = (id: string, startUs: number, endUs: number): Cut => ({ id, startUs, endUs });
const D = 10_000_000;

describe("keptSegments", () => {
  test("no cuts gives one segment", () => {
    expect(keptSegments(D, [])).toEqual([{ srcStartUs: 0, srcEndUs: D, outStartUs: 0 }]);
  });

  test("one middle cut gives two segments with shifted output start", () => {
    expect(keptSegments(D, [cut("a", 2_000_000, 5_000_000)])).toEqual([
      { srcStartUs: 0, srcEndUs: 2_000_000, outStartUs: 0 },
      { srcStartUs: 5_000_000, srcEndUs: D, outStartUs: 2_000_000 },
    ]);
  });

  test("overlapping cuts merge", () => {
    const segs = keptSegments(D, [cut("a", 2_000_000, 5_000_000), cut("b", 4_000_000, 8_000_000)]);
    expect(segs).toHaveLength(2);
    expect(segs[1]).toEqual({ srcStartUs: 8_000_000, srcEndUs: D, outStartUs: 2_000_000 });
  });

  test("a cut covering everything leaves nothing", () => {
    const segs = keptSegments(D, [cut("a", 0, D)]);
    expect(segs).toEqual([]);
    expect(outputDurationUs(segs)).toBe(0);
  });

  test("cuts are clamped to the duration", () => {
    const segs = keptSegments(D, [cut("a", -5_000_000, 1_000_000), cut("b", 9_000_000, 20_000_000)]);
    expect(segs).toEqual([{ srcStartUs: 1_000_000, srcEndUs: 9_000_000, outStartUs: 0 }]);
  });

  test("zero-length and inverted cuts are ignored", () => {
    expect(keptSegments(D, [cut("a", 3_000_000, 3_000_000), cut("b", 6_000_000, 4_000_000)])).toEqual([
      { srcStartUs: 0, srcEndUs: D, outStartUs: 0 },
    ]);
  });

  test("unsorted cuts are handled", () => {
    const segs = keptSegments(D, [cut("b", 6_000_000, 7_000_000), cut("a", 1_000_000, 2_000_000)]);
    expect(segs.map((s) => s.srcStartUs)).toEqual([0, 2_000_000, 7_000_000]);
  });
});

describe("time mapping", () => {
  const segs = keptSegments(D, [cut("a", 2_000_000, 5_000_000)]);

  test("outputDurationUs sums kept time", () => {
    expect(outputDurationUs(segs)).toBe(7_000_000);
  });

  test("sourceToOutput is null inside a cut and shifted after it", () => {
    expect(sourceToOutput(segs, 1_000_000)).toBe(1_000_000);
    expect(sourceToOutput(segs, 3_000_000)).toBeNull();
    expect(sourceToOutput(segs, 6_000_000)).toBe(3_000_000);
  });

  test("outputToSource inverts kept times", () => {
    for (const src of [0, 1_999_999, 5_000_000, 9_500_000]) {
      const out = sourceToOutput(segs, src)!;
      expect(outputToSource(segs, out)).toBe(src);
    }
  });

  test("outputToSource clamps past the end and handles no segments", () => {
    expect(outputToSource(segs, 99_000_000)).toBe(D);
    expect(outputToSource([], 5)).toBe(0);
  });
});
