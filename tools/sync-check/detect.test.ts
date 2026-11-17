import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { makeSample } from "../make-sample/make-sample";
import { detectFlashes, detectOnsets, judgeClicks, judgeFlash, meanAbsMs, pairNearest, summarize } from "./detect";
import { analyzeProject } from "./sync-check";

/** Deterministic pseudo noise in [-amp, amp]. */
function noise(n: number, amp: number): Int16Array {
  const out = new Int16Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round(((s / 0x7fffffff) * 2 - 1) * amp);
  }
  return out;
}

function addBeep(samples: Int16Array, rate: number, atSec: number, amp = 20000, ms = 100, hz = 1000): void {
  const start = Math.round(atSec * rate);
  const n = Math.round((ms / 1000) * rate);
  for (let i = 0; i < n && start + i < samples.length; i++) {
    samples[start + i] = (samples[start + i] ?? 0) + Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate));
  }
}

describe("detectFlashes", () => {
  test("finds frames 30 and 210 at 30 fps", () => {
    const luma = new Uint8Array(300).fill(16);
    for (const f of [30, 210]) for (let i = 0; i < 3; i++) luma[f + i] = 235;
    expect(detectFlashes(luma, 30)).toEqual([1_000_000, 7_000_000]);
  });

  test("a half-lit transition frame does not fire early or twice", () => {
    const luma = new Uint8Array(100).fill(16);
    luma[40] = 120;
    for (let i = 41; i < 44; i++) luma[i] = 235;
    expect(detectFlashes(luma, 50)).toEqual([820_000]);
  });

  test("a bright screen that stays bright is not a flash", () => {
    const luma = new Uint8Array(100).fill(235);
    expect(detectFlashes(luma, 30)).toEqual([]);
  });

  test("a mid grey screen never fires", () => {
    expect(detectFlashes(new Uint8Array(100).fill(120), 30)).toEqual([]);
  });
});

describe("detectOnsets", () => {
  test("finds a beep at 1.000 s in noise to within 1 ms", () => {
    const rate = 48000;
    const s = noise(rate * 3, 60);
    addBeep(s, rate, 1.0);
    const on = detectOnsets(s, rate);
    expect(on).toHaveLength(1);
    expect(Math.abs(on[0]! - 1_000_000)).toBeLessThanOrEqual(1000);
  });

  test("finds a beep that starts mid window to within 1 ms", () => {
    const rate = 48000;
    const s = noise(rate * 3, 60);
    addBeep(s, rate, 1.0013);
    const on = detectOnsets(s, rate);
    expect(on).toHaveLength(1);
    expect(Math.abs(on[0]! - 1_001_300)).toBeLessThanOrEqual(1000);
  });

  test("finds every beep, one onset each, and ignores digital silence", () => {
    const rate = 48000;
    const s = new Int16Array(rate * 10);
    for (const t of [1, 4, 7]) addBeep(s, rate, t);
    const on = detectOnsets(s, rate);
    expect(on).toHaveLength(3);
    on.forEach((u, i) => expect(Math.abs(u - [1, 4, 7][i]! * 1e6)).toBeLessThanOrEqual(1000));
    expect(detectOnsets(new Int16Array(rate * 2), rate)).toEqual([]);
  });

  test("minGapMs merges a beep's own ring into one onset", () => {
    const rate = 48000;
    const s = noise(rate * 2, 40);
    addBeep(s, rate, 0.5, 20000, 100);
    addBeep(s, rate, 0.62, 20000, 100); // 120 ms later: inside the gap
    expect(detectOnsets(s, rate, 500)).toHaveLength(1);
    expect(detectOnsets(s, rate, 50)).toHaveLength(2);
  });
});

describe("pairNearest and summarize", () => {
  test("pairs each a with the nearest b within the gap and returns b minus a", () => {
    expect(pairNearest([1_000_000, 4_000_000, 7_000_000], [1_030_000, 3_990_000, 9_000_000], 500_000)).toEqual([30_000, -10_000]);
  });

  test("summarize gives count, mean, min, max and spread in ms", () => {
    expect(summarize([10_000, 20_000, 30_000])).toEqual({ count: 3, meanMs: 20, minMs: 10, maxMs: 30, spreadMs: 20 });
    expect(summarize([])).toEqual({ count: 0, meanMs: 0, minMs: 0, maxMs: 0, spreadMs: 0 });
  });
});

describe("verdicts", () => {
  const ok = { count: 21, meanMs: 40, minMs: 35, maxMs: 48, spreadMs: 13 };
  test("flash passes inside the limits and the latency window", () => {
    expect(judgeFlash(ok, 40, 40).pass).toBe(true);
  });
  test("flash fails on spread, offset, pair count and latency mismatch", () => {
    expect(judgeFlash({ ...ok, spreadMs: 20 }, 40, 40).pass).toBe(false);
    expect(judgeFlash({ ...ok, meanMs: 60, minMs: 55, maxMs: 65 }, 60, null).pass).toBe(false);
    expect(judgeFlash({ ...ok, count: 12 }, 40, 40).pass).toBe(false);
    expect(judgeFlash(ok, 40, 20).pass).toBe(false);
  });
  test("flash without a known render latency does not fail on it, and says so", () => {
    const j = judgeFlash(ok, 40, null);
    expect(j.pass).toBe(true);
    expect(j.lines.join("\n")).toMatch(/not checked/);
  });
  test("click passes at 20 ms mean absolute or less with at least 8 pairs", () => {
    expect(judgeClicks({ count: 10, meanMs: 12, minMs: 5, maxMs: 20, spreadMs: 15 }, 12).pass).toBe(true);
    expect(judgeClicks({ count: 8, meanMs: 12, minMs: 5, maxMs: 20, spreadMs: 15 }, 12).pass).toBe(true);
    expect(judgeClicks({ count: 10, meanMs: 25, minMs: 20, maxMs: 30, spreadMs: 10 }, 25).pass).toBe(false);
    expect(judgeClicks(summarize([]), 0).pass).toBe(false);
  });
  test("click fails with fewer than 8 pairs, even when they are exact", () => {
    expect(judgeClicks({ count: 7, meanMs: 5, minMs: 5, maxMs: 5, spreadMs: 0 }, 5).pass).toBe(false);
    expect(judgeClicks({ count: 1, meanMs: 5, minMs: 5, maxMs: 5, spreadMs: 0 }, 5).pass).toBe(false);
  });
  test("click +30 ms and -30 ms do not cancel: the mean of absolute deltas is judged", () => {
    const deltas = [30_000, -30_000, 30_000, -30_000, 30_000, -30_000, 30_000, -30_000];
    const s = summarize(deltas);
    expect(s.meanMs).toBe(0);
    expect(judgeClicks(s, meanAbsMs(deltas)).pass).toBe(false);
  });
});

describe("analyzer on a synthetic sample", () => {
  // Flash frames sit on frame boundaries in the sample, so the read is exact; 3 ms still catches a
  // flipped offset sign (the 12.4 ms mic offset would shift the read by 24.8 ms).
  const tolerance = 3;
  const make = async (syncOffsetMs: number) => {
    const dir = join(mkdtempSync(join(tmpdir(), "marz-sync-")), "sync.marz");
    await makeSample(dir, { durationSec: 11, syncOffsetMs });
    return analyzeProject(dir);
  };

  test("syncOffsetMs 0 reports mean 0 ms within 3 ms", async () => {
    const r = await make(0);
    expect(r.flashes).toBe(3);
    expect(r.beeps).toBe(3);
    expect(r.flash.count).toBe(3);
    expect(Math.abs(r.flash.meanMs)).toBeLessThanOrEqual(tolerance);
  }, 60_000);

  test("syncOffsetMs 30 reports mean 30 ms within 3 ms", async () => {
    const r = await make(30);
    expect(r.flash.count).toBe(3);
    expect(Math.abs(r.flash.meanMs - 30)).toBeLessThanOrEqual(tolerance);
  }, 60_000);
});
