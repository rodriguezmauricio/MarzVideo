import { describe, expect, test } from "vitest";
import { captionLayout, type CaptionBlock, type Measure } from "./captions";

const measure: Measure = (text, px) => text.length * px * 0.5;
const S = 1_000_000;
const block = (startUs: number, endUs: number, lines: string[][]): CaptionBlock => {
  let t = startUs;
  return {
    startUs,
    endUs,
    lines: lines.map((ws) => ({ words: ws.map((text) => ({ text, startUs: (t += 300_000) - 300_000, endUs: t - 50_000 })) })),
  };
};
const blocks = [block(0, 2 * S, [["Open", "the", "menu"], ["and", "click", "export"]]), block(3 * S, 4 * S, [["Done."]])];
const youtube = { width: 1920, height: 1080 };
const full = { x: 0, y: 0, w: 1920, h: 1080 };

describe("captionLayout", () => {
  test("no caption between lines", () => {
    expect(captionLayout(blocks, 2.5 * S, "subtitles", youtube, full, measure)).toBeNull();
    expect(captionLayout(blocks, 3.1 * S, "subtitles", youtube, full, measure)).not.toBeNull();
  });

  test("highlight lights the current word", () => {
    const d = captionLayout(blocks, 0.65 * S, "highlight", youtube, full, measure)!;
    const flat = d.lines.flatMap((l) => l.words);
    expect(flat.filter((w) => w.lit).map((w) => w.text)).toEqual(["menu"]);
    const sub = captionLayout(blocks, 0.65 * S, "subtitles", youtube, full, measure)!;
    expect(sub.lines.flatMap((l) => l.words).some((w) => w.lit)).toBe(false);
  });

  test("subtitles sit inside the 16:9 frame bottom", () => {
    const d = captionLayout(blocks, S, "subtitles", youtube, full, measure)!;
    expect(d.fontPx).toBeCloseTo(48.6);
    expect(d.band).not.toBeNull();
    const b = d.band!;
    expect(b.y + b.h).toBeCloseTo(1080 - 0.06 * 1080);
    expect(b.x + b.w / 2).toBeCloseTo(960);
    expect(d.lines).toHaveLength(2);
    expect(d.lines[1]!.baseline).toBeGreaterThan(d.lines[0]!.baseline);
  });

  test("vertical highlight sits in the ink area under the frame", () => {
    const out = { width: 1080, height: 1920 };
    const frame = { x: 0, y: 656, w: 1080, h: 608 };
    const d = captionLayout(blocks, 3.5 * S, "highlight", out, frame, measure)!;
    expect(d.band).toBeNull();
    expect(d.fontPx).toBeCloseTo(81);
    expect(d.lines[0]!.baseline).toBeGreaterThan(frame.y + frame.h);
    expect(d.lines[0]!.baseline).toBeLessThan(1920);
  });

  test("layout is the same for preview and export sizes after scaling", () => {
    const big = captionLayout(blocks, S, "subtitles", youtube, full, measure)!;
    const small = captionLayout(blocks, S, "subtitles", { width: 640, height: 360 }, { x: 0, y: 0, w: 640, h: 360 }, measure)!;
    const k = 640 / 1920;
    expect(small.fontPx).toBeCloseTo(big.fontPx * k);
    expect(small.band!.y).toBeCloseTo(big.band!.y * k);
    expect(small.lines[0]!.words[1]!.x).toBeCloseTo(big.lines[0]!.words[1]!.x * k);
  });
});
