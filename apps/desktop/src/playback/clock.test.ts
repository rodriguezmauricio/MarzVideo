import { describe, expect, test } from "vitest";
import { keptSegments } from "@marz/timeline";
import type { Project } from "@marz/format";
import { audioStep, mediaTimeUs, nextPlaybackTime, sourceTimeUs } from "./clock";

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

describe("mediaTimeUs", () => {
  const project = { tracks: { screen: { file: "screen.mp4", offsetUs: 250_000 } } } as unknown as Project;

  test("subtracts the screen track offset", () => {
    expect(mediaTimeUs(project, 1_000_000, 0)).toBe(750_000);
    expect(mediaTimeUs(project, 0, 0)).toBe(-250_000);
  });

  test("frame 0 sits at the file's first presentation time", () => {
    // B-frame file: frame 0 is presented at 50 ms but was captured at offsetUs.
    expect(mediaTimeUs(project, 250_000, 50_000)).toBe(50_000);
    expect(mediaTimeUs(project, 1_000_000, 50_000)).toBe(800_000);
  });

  test("sourceTimeUs is the inverse", () => {
    for (const first of [0, 50_000, 66_667]) {
      for (const src of [0, 250_000, 1_234_567]) expect(sourceTimeUs(project, mediaTimeUs(project, src, first), first)).toBe(src);
    }
    expect(sourceTimeUs(project, 50_000, 50_000)).toBe(250_000);
  });
});

describe("audioStep", () => {
  const base = { currentS: 0, paused: true, ended: false, videoPaused: false };

  test("before the track starts, a playing track pauses at its start instead of running ahead", () => {
    expect(audioStep({ ...base, wantS: -0.3, currentS: 0.2, paused: false })).toEqual({ pause: true, seekS: 0 });
  });

  test("before the track starts, a paused track waits", () => {
    expect(audioStep({ ...base, wantS: -0.3 })).toEqual({});
  });

  test("once the track starts it plays", () => {
    expect(audioStep({ ...base, wantS: 0.01, currentS: 0 })).toEqual({ play: true });
  });

  test("drift over 40 ms seeks", () => {
    expect(audioStep({ ...base, wantS: 2, currentS: 2.1, paused: false })).toEqual({ seekS: 2 });
    expect(audioStep({ ...base, wantS: 2, currentS: 2.02, paused: false })).toEqual({});
  });

  test("an ended track is left alone", () => {
    expect(audioStep({ ...base, wantS: 5, currentS: 3, ended: true })).toEqual({});
  });
});
