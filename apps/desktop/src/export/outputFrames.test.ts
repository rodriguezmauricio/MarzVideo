import { describe, expect, it } from "vitest";
import { keptSegments } from "@marz/timeline";
import type { Cut } from "@marz/format";
import { outputFrameTimes, refuseEmpty } from "./outputFrames";
import { PRESETS } from "./presets";

const cut = (startUs: number, endUs: number): Cut => ({ id: `c${startUs}`, startUs, endUs }) as Cut;

describe("outputFrameTimes", () => {
  it("2 s at 30 fps with no cuts gives 60 times", () => {
    const t = [...outputFrameTimes(keptSegments(2_000_000, []), 30)];
    expect(t).toHaveLength(60);
    expect(t[0]).toBe(0);
    expect(t[59]).toBe(1_966_667);
  });

  it("a cut 0.5 s to 1.5 s gives 30 times, none inside the cut", () => {
    const t = [...outputFrameTimes(keptSegments(2_000_000, [cut(500_000, 1_500_000)]), 30)];
    expect(t).toHaveLength(30);
    expect(t.filter((us) => us >= 500_000 && us < 1_500_000)).toEqual([]);
    expect(t[14]).toBe(466_667);
    expect(t[15]).toBe(1_500_000);
  });

  it("all cut gives no times and refuseEmpty explains", () => {
    const segs = keptSegments(2_000_000, [cut(0, 2_000_000)]);
    expect([...outputFrameTimes(segs, 30)]).toEqual([]);
    expect(refuseEmpty(segs)).toBe("Nothing left to export. Every part is cut.");
  });

  it("refuseEmpty is null when something is kept", () => {
    expect(refuseEmpty(keptSegments(2_000_000, []))).toBeNull();
  });

  it("a 60 fps source to the vertical preset gives half the frame times of the YouTube preset", () => {
    const segs = keptSegments(2_000_000, []);
    const yt = [...outputFrameTimes(segs, PRESETS.youtube.fps(60))];
    const vert = [...outputFrameTimes(segs, PRESETS.vertical.fps(60))];
    expect(yt).toHaveLength(120);
    expect(vert).toHaveLength(60);
  });
});

describe("presets", () => {
  it("youtube keeps source fps up to 60", () => {
    expect(PRESETS.youtube.fps(30)).toBe(30);
    expect(PRESETS.youtube.fps(60)).toBe(60);
    expect(PRESETS.youtube.fps(120)).toBe(60);
  });

  it("youtube is 1920 x 1080, 12 Mbit/s at 60 fps and 8 at 30, keyframe every 1 s, whole frame", () => {
    const p = PRESETS.youtube;
    expect([p.width, p.height]).toEqual([1920, 1080]);
    expect(p.bitrate(60)).toBe(12_000_000);
    expect(p.bitrate(30)).toBe(8_000_000);
    expect(p.keyframeEverySec).toBe(1);
    expect(p.frameRect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it("vertical is 1080 x 1920 at 30 fps, 6 Mbit/s", () => {
    const p = PRESETS.vertical;
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(p.fps(60)).toBe(30);
    expect(p.fps(30)).toBe(30);
    expect(p.bitrate(p.fps(60))).toBe(6_000_000);
    expect(p.keyframeEverySec).toBe(1);
  });

  it("vertical frame rect is { x: 0, y: 656, w: 1080, h: 608 }", () => {
    expect(PRESETS.vertical.frameRect).toEqual({ x: 0, y: 656, w: 1080, h: 608 });
  });
});
