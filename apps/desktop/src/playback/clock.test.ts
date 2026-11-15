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

import { playbackEnded, startTimeForPlay } from "./clock";

describe("playbackEnded", () => {
  const segs = keptSegments(D, [cut("a", 2_000_000, 5_000_000)]);
  test("ended when the clock is past the last segment", () => {
    expect(playbackEnded(segs, D, false)).toBe(true);
  });
  test("ended when the video element ended even if the clock is short of the duration", () => {
    expect(playbackEnded(segs, D - 50_000, true)).toBe(true);
  });
  test("not ended mid-video", () => {
    expect(playbackEnded(segs, 1_000_000, false)).toBe(false);
  });
});

describe("startTimeForPlay", () => {
  const segs = keptSegments(D, [cut("a", 0, 1_000_000)]);
  test("resumes from the playhead when there is more to play", () => {
    expect(startTimeForPlay(segs, 4_000_000)).toBe(4_000_000);
  });
  test("restarts from the first kept time when the playhead is at the end", () => {
    expect(startTimeForPlay(segs, D)).toBe(1_000_000);
  });
  test("returns null when nothing is kept", () => {
    expect(startTimeForPlay([], 0)).toBeNull();
  });
});
