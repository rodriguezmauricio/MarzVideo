import { describe, expect, test } from "vitest";
import { count, editedTimeUs, mmss, mmsst, parseTimeUs, seconds1 } from "./timecode";

describe("timecode", () => {
  test("formats mm:ss and mm:ss.t", () => {
    expect(mmss(63_400_000)).toBe("01:03");
    expect(mmss(160_000_000)).toBe("02:40");
    expect(mmsst(58_000_000)).toBe("00:58.0");
    expect(mmsst(98_960_000)).toBe("01:39.0");
    expect(seconds1(12_000_000)).toBe("12.0 s");
  });

  test("parses what the inspector shows, and plain seconds", () => {
    expect(parseTimeUs("01:32.0")).toBe(92_000_000);
    expect(parseTimeUs("0.4 s")).toBe(400_000);
    expect(parseTimeUs("7.5")).toBe(7_500_000);
    expect(parseTimeUs("abc")).toBeNull();
    expect(parseTimeUs("")).toBeNull();
  });

  test("counts with plurals", () => {
    expect(count(1, "cut")).toBe("1 cut");
    expect(count(3, "zoom")).toBe("3 zooms");
  });
});

describe("editedTimeUs", () => {
  test("an unchanged field commits nothing (no rounding, no undo step)", () => {
    expect(editedTimeUs("00:04.3", "00:04.3")).toBeNull();
    expect(editedTimeUs(" 00:04.3 ", "00:04.3")).toBeNull();
  });
  test("a new time commits", () => {
    expect(editedTimeUs("00:05.0", "00:04.3")).toBe(5_000_000);
  });
  test("text that is not a time commits nothing", () => {
    expect(editedTimeUs("abc", "00:04.3")).toBeNull();
  });
});
