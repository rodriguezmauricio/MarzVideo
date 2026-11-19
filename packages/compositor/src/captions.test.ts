import { describe, expect, test } from "vitest";
import { captionLayout, type CaptionBlock, type CaptionLookOpts, type Measure } from "./captions";

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
const SUB: CaptionLookOpts = { style: "inkBand", size: "M", position: "bottom", highlight: false };
const HI: CaptionLookOpts = { style: "plain", size: "M", position: "bottom", highlight: true };
const vOut = { width: 1080, height: 1920 };
const vFrame = { x: 0, y: 656, w: 1080, h: 608 };

describe("captionLayout", () => {
  test("no caption between lines", () => {
    expect(captionLayout(blocks, 2.5 * S, SUB, youtube, full, measure)).toBeNull();
    expect(captionLayout(blocks, 3.1 * S, SUB, youtube, full, measure)).not.toBeNull();
  });

  test("highlight lights the current word", () => {
    const d = captionLayout(blocks, 0.65 * S, HI, youtube, full, measure)!;
    const flat = d.lines.flatMap((l) => l.words);
    expect(flat.filter((w) => w.lit).map((w) => w.text)).toEqual(["menu"]);
    const sub = captionLayout(blocks, 0.65 * S, SUB, youtube, full, measure)!;
    expect(sub.lines.flatMap((l) => l.words).some((w) => w.lit)).toBe(false);
  });

  test("subtitles sit inside the 16:9 frame bottom", () => {
    const d = captionLayout(blocks, S, SUB, youtube, full, measure)!;
    expect(d.fontPx).toBeCloseTo(48.6);
    expect(d.band).not.toBeNull();
    const b = d.band!;
    expect(b.y + b.h).toBeCloseTo(1080 - 0.06 * 1080);
    expect(b.x + b.w / 2).toBeCloseTo(960);
    expect(d.lines).toHaveLength(2);
    expect(d.lines[1]!.baseline).toBeGreaterThan(d.lines[0]!.baseline);
  });

  test("vertical highlight sits in the ink area under the frame", () => {
    const out = vOut;
    const frame = vFrame;
    const d = captionLayout(blocks, 3.5 * S, HI, out, frame, measure)!;
    expect(d.band).toBeNull();
    expect(d.fontPx).toBeCloseTo(81);
    expect(d.lines[0]!.baseline).toBeGreaterThan(frame.y + frame.h);
    expect(d.lines[0]!.baseline).toBeLessThan(1920);
  });

  test("layout is the same for preview and export sizes after scaling", () => {
    const big = captionLayout(blocks, S, SUB, youtube, full, measure)!;
    const small = captionLayout(blocks, S, SUB, { width: 640, height: 360 }, { x: 0, y: 0, w: 640, h: 360 }, measure)!;
    const k = 640 / 1920;
    expect(small.fontPx).toBeCloseTo(big.fontPx * k);
    expect(small.band!.y).toBeCloseTo(big.band!.y * k);
    expect(small.lines[0]!.words[1]!.x).toBeCloseTo(big.lines[0]!.words[1]!.x * k);
  });

  test("Top in the vertical letterbox sits in the ink area above the frame", () => {
    const d = captionLayout(blocks, 3.5 * S, { ...HI, position: "top" }, vOut, vFrame, measure)!;
    expect(d.lines[0]!.baseline).toBeLessThan(vFrame.y);
    expect(d.lines[0]!.top).toBeGreaterThan(0);
  });

  test("Middle sits over the centre of the picture", () => {
    const d = captionLayout(blocks, 3.5 * S, { ...HI, position: "middle" }, vOut, vFrame, measure)!;
    const mid = d.lines[0]!.top + d.lines[0]!.height / 2;
    expect(mid).toBeCloseTo(vFrame.y + vFrame.h / 2);
    const y = captionLayout(blocks, 3.5 * S, { ...SUB, position: "middle" }, youtube, full, measure)!;
    expect(y.band!.y + y.band!.h / 2).toBeCloseTo(540);
  });

  test("Top inside a 16:9 frame: band top 6 % under the frame top", () => {
    const d = captionLayout(blocks, S, { ...SUB, position: "top" }, youtube, full, measure)!;
    expect(d.band!.y).toBeCloseTo(0.06 * 1080);
  });

  test("size S, M, L scale the font", () => {
    const m = captionLayout(blocks, 3.5 * S, SUB, youtube, full, measure)!.fontPx;
    expect(captionLayout(blocks, 3.5 * S, { ...SUB, size: "S" }, youtube, full, measure)!.fontPx).toBeCloseTo(m * 0.8);
    expect(captionLayout(blocks, 3.5 * S, { ...SUB, size: "L" }, youtube, full, measure)!.fontPx).toBeCloseTo(m * 1.25);
  });

  test("a line too wide for the picture shrinks the font instead", () => {
    const long = [block(0, S, [["Thisisaverylongcaptionwordthatcannotfitanywhereatall"]])];
    const d = captionLayout(long, 0.1 * S, { ...SUB, size: "L" }, youtube, full, measure)!;
    expect(d.band!.w).toBeLessThanOrEqual(1920 * 0.94 + 0.01);
  });

  test("styles pick their tokens", () => {
    const at = (style: CaptionLookOpts["style"]) => captionLayout(blocks, 0.65 * S, { ...SUB, style, highlight: true }, youtube, full, measure)!;
    expect(at("inkBand")).toMatchObject({ band: { tone: "ink" }, text: "paper", lit: "accent", litBox: null, outlinePx: 0 });
    expect(at("paperBand")).toMatchObject({ band: { tone: "paper" }, text: "ink", litBox: "ink" });
    expect(at("accentBand")).toMatchObject({ band: { tone: "accent" }, text: "ink", litBox: "ink" });
    const plain = at("plain");
    expect(plain.band).toBeNull();
    expect(plain.outlinePx).toBeGreaterThan(0);
  });
});

describe("captionLayout in a caption area (smart vertical)", () => {
  const area = { x: 65, y: 250, w: 950, h: 1024 };
  const vFull = { x: 0, y: 0, w: 1080, h: 1920 };
  test("Bottom sits at the area's bottom, Top at its top, Middle centred; sized on the output width", () => {
    const b = captionLayout(blocks, 0.5 * S, HI, vOut, vFull, measure, area)!;
    const last = b.lines[b.lines.length - 1]!;
    expect(last.top + last.height).toBeCloseTo(area.y + area.h, 6);
    expect(b.fontPx).toBeCloseTo(1080 * 0.075, 6);
    const t = captionLayout(blocks, 0.5 * S, { ...HI, position: "top" }, vOut, vFull, measure, area)!;
    expect(t.lines[0]!.top).toBeCloseTo(area.y, 6);
    const m = captionLayout(blocks, 0.5 * S, { ...HI, position: "middle" }, vOut, vFull, measure, area)!;
    const mid = (m.lines[0]!.top + m.lines[m.lines.length - 1]!.top + m.lines[0]!.height) / 2;
    expect(mid).toBeCloseTo(area.y + area.h / 2, 6);
  });
  test("lines stay inside the area's width", () => {
    const long = [block(0, 2 * S, [["Exceptionally", "long", "words", "here"]])];
    const d = captionLayout(long, 0.5 * S, HI, vOut, vFull, measure, area)!;
    for (const l of d.lines) {
      const left = l.words[0]!.x;
      const right = l.words[l.words.length - 1]!.x + l.words[l.words.length - 1]!.w;
      expect(left).toBeGreaterThanOrEqual(area.x - 1e-6);
      expect(right).toBeLessThanOrEqual(area.x + area.w + 1e-6);
    }
  });
});
