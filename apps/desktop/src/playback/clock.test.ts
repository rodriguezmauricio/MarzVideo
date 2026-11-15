import { describe, expect, test } from "vitest";
import { keptSegments } from "@marz/timeline";
import { nextPlaybackTime } from "./clock";

const D = 10_000_000;
const cut = (id: string, startUs: number, endUs: number) => ({ id, startUs, endUs });

describe("nextPlaybackTime", () => {
  const segs = keptSegments(D, [cut("a", 2_000_000, 5_000_000)]);

  test("outside cuts returns the same time", () => {
    expect(nextPlaybackTime(segs, 1_000_000)).toBe(1_000_000);
    expect(nextPlaybackTime(segs, 5_000_000)).toBe(5_000_000);
  });

  test("inside a cut jumps to the end of the cut", () => {
    expect(nextPlaybackTime(segs, 2_000_000)).toBe(5_000_000);
    expect(nextPlaybackTime(segs, 3_500_000)).toBe(5_000_000);
  });

  test("at or after the end returns null", () => {
    expect(nextPlaybackTime(segs, D)).toBeNull();
    expect(nextPlaybackTime(segs, D + 1)).toBeNull();
  });

  test("a cut at the very start jumps to the first kept time", () => {
    const s = keptSegments(D, [cut("a", 0, 1_000_000)]);
    expect(nextPlaybackTime(s, 0)).toBe(1_000_000);
  });

  test("nothing kept returns null", () => {
    expect(nextPlaybackTime([], 0)).toBeNull();
  });

  test("a tail cut returns null once playback reaches it", () => {
    const s = keptSegments(D, [cut("a", 8_000_000, D)]);
    expect(nextPlaybackTime(s, 8_500_000)).toBeNull();
  });
});
