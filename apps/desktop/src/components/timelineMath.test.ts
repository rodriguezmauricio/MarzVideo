import { describe, expect, test } from "vitest";
import { pxToUs, snapUs, usToPx } from "./timelineMath";

describe("timelineMath", () => {
  test("pxToUs inverts usToPx within 1 microsecond", () => {
    for (const us of [0, 1, 999_999, 12_345_678, 63_500_000]) {
      for (const pps of [10, 37.5, 200]) {
        expect(Math.abs(pxToUs(usToPx(us, pps), pps) - us)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("usToPx scales by pixels per second", () => {
    expect(usToPx(2_000_000, 50)).toBe(100);
  });

  test("snapUs snaps to a target within the threshold", () => {
    expect(snapUs(1_004_000, [1_000_000, 5_000_000], 10_000)).toBe(1_000_000);
  });

  test("snapUs leaves a value alone when no target is close", () => {
    expect(snapUs(3_000_000, [1_000_000, 5_000_000], 10_000)).toBe(3_000_000);
  });

  test("snapUs picks the nearest of several targets", () => {
    expect(snapUs(1_006_000, [1_000_000, 1_009_000], 10_000)).toBe(1_009_000);
  });

  test("snapUs with no targets returns the value", () => {
    expect(snapUs(42, [], 10_000)).toBe(42);
  });
});

import { handleWidthPx, timelineWidthPx } from "./timelineMath";

describe("timeline scale", () => {
  test("handle width shrinks on small blocks so the middle stays grabbable", () => {
    expect(handleWidthPx(200)).toBe(8);
    expect(handleWidthPx(12)).toBe(4);
    expect(handleWidthPx(4)).toBe(1);
  });
  test("timeline width is the viewport times the zoom factor, clamped to 1..60", () => {
    expect(timelineWidthPx(1000, 1)).toBe(1000);
    expect(timelineWidthPx(1000, 4)).toBe(4000);
    expect(timelineWidthPx(1000, 0.2)).toBe(1000);
    expect(timelineWidthPx(1000, 500)).toBe(60_000);
  });
});
