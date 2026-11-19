import type { Word } from "@marz/format";
import { describe, expect, test } from "vitest";
import { isPureFiller } from "./fillers";
import type { Levels } from "./levels";
import { cleanWords, levelCuts, ruleCuts } from "./rules";

const S = 1_000_000;
const ms = (n: number) => n * 1000;
let n = 0;
const w = (text: string, startMs: number, endMs: number): Word => ({ id: `w${++n}`, text, startUs: ms(startMs), endUs: ms(endMs), p: 0.9 });
const opts = { silenceGapUs: ms(800), paceUs: ms(300), durationUs: 20 * S };

/** Levels with voice (0.2) over the given ranges and near silence (0.001) elsewhere. */
function levels(durationUs: number, voiced: Array<[number, number]>): Levels {
  const steps = durationUs / 10_000;
  const rms = new Float32Array(steps).fill(0.001);
  for (const [a, b] of voiced) for (let i = a / 10_000; i < b / 10_000; i++) rms[i] = 0.2;
  return { stepUs: 10000, offsetUs: 0, rms, floor: 0.01 };
}
const voicedFor = (words: Word[]): Array<[number, number]> => words.map((x) => [x.startUs, x.endUs]);

describe("ruleCuts", () => {
  test("cuts a 2 s gap leaving 300 ms each side", () => {
    const words = [w("one", 0, 500), w("two", 2500, 3000)];
    const cuts = ruleCuts(words, null, { ...opts, durationUs: 3 * S });
    expect(cuts).toEqual([{ startUs: ms(800), endUs: ms(2200), reason: "silence", fromWordId: words[0]!.id, toWordId: words[1]!.id }]);
  });

  test("ignores a 500 ms gap", () => {
    const words = [w("one", 0, 500), w("two", 1000, 1500)];
    expect(ruleCuts(words, null, { ...opts, durationUs: ms(1500) })).toEqual([]);
  });

  test("keeps a gap that has voice in it", () => {
    const words = [w("one", 0, 500), w("two", 2500, 3000)];
    const lv = levels(3 * S, [...voicedFor(words), [ms(1000), ms(1800)]]);
    expect(ruleCuts(words, lv, { ...opts, durationUs: 3 * S })).toEqual([]);
  });

  test("cuts a quiet gap when levels are known", () => {
    const words = [w("one", 0, 500), w("two", 2500, 3000)];
    const lv = levels(3 * S, voicedFor(words));
    expect(ruleCuts(words, lv, { ...opts, durationUs: 3 * S })).toHaveLength(1);
  });

  test("cuts umm and éé", () => {
    const a = [w("Então", 0, 400), w("umm", 500, 900), w("vamos", 1000, 1400)];
    const b = [w("Então", 0, 400), w("éé", 500, 900), w("vamos", 1000, 1400)];
    for (const words of [a, b]) {
      const cuts = ruleCuts(words, null, { ...opts, durationUs: ms(1400) });
      expect(cuts).toEqual([{ startUs: ms(500), endUs: ms(900), reason: "filler", fromWordId: words[1]!.id, toWordId: words[1]!.id }]);
    }
  });

  test("a filler with long gaps keeps the pace on each side", () => {
    const words = [w("one", 0, 400), w("uh", 1000, 1300), w("two", 1900, 2300)];
    const cuts = ruleCuts(words, null, { ...opts, durationUs: ms(2300) });
    expect(cuts).toEqual([{ startUs: ms(700), endUs: ms(1600), reason: "filler", fromWordId: words[1]!.id, toWordId: words[1]!.id }]);
  });

  test("keeps a short é between words", () => {
    const words = [w("Isso", 0, 300), w("é", 350, 450), w("bom", 500, 800)];
    expect(ruleCuts(words, null, { ...opts, durationUs: ms(800) })).toEqual([]);
  });

  test("cuts a lone é held 450 ms", () => {
    const words = [w("menu.", 0, 300), w("é", 600, 1050), w("Tipo", 1300, 1600)];
    const cuts = ruleCuts(words, null, { ...opts, durationUs: ms(1600) });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ reason: "filler", startUs: ms(600), endUs: ms(1050) });
  });

  test("merges a filler next to a silence", () => {
    const words = [w("one", 0, 400), w("umm", 1600, 2000), w("two", 2100, 2500)];
    const cuts = ruleCuts(words, null, { ...opts, durationUs: ms(2500) });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ startUs: ms(700), endUs: ms(2000), reason: "filler", fromWordId: words[0]!.id, toWordId: words[1]!.id });
  });

  test("cuts the dead air before the first and after the last word, clamped to the duration", () => {
    const words = [w("one", 2000, 2400), w("two", 2500, 2900)];
    const cuts = ruleCuts(words, null, { ...opts, durationUs: 5 * S });
    expect(cuts).toEqual([
      { startUs: 0, endUs: ms(1700), reason: "silence", fromWordId: "^", toWordId: words[0]!.id },
      { startUs: ms(3200), endUs: 5 * S, reason: "silence", fromWordId: words[1]!.id, toWordId: "$" },
    ]);
  });

  test("clamps to the duration", () => {
    const words = [w("one", 0, 400), w("umm", 900, 1300)];
    const cuts = ruleCuts(words, null, { ...opts, durationUs: ms(1200) });
    for (const c of cuts) {
      expect(c.startUs).toBeGreaterThanOrEqual(0);
      expect(c.endUs).toBeLessThanOrEqual(ms(1200));
    }
  });

  test("no words gives no cuts", () => {
    expect(ruleCuts([], null, opts)).toEqual([]);
    expect(ruleCuts([], levels(20 * S, []), opts)).toEqual([]);
  });

  test("pace 80 ms gives tighter cuts than 600 ms", () => {
    const words = [w("one", 0, 500), w("two", 3000, 3500)];
    const len = (pace: number) =>
      ruleCuts(words, null, { ...opts, paceUs: ms(pace), durationUs: ms(3500) }).reduce((s, c) => s + c.endUs - c.startUs, 0);
    expect(len(80)).toBeGreaterThan(len(600));
    expect(len(80)).toBe(ms(2500 - 160));
  });
});

describe("cleanWords", () => {
  test("drops words over silent audio", () => {
    const words = [w("Hello", 0, 400), w("Obrigado.", 5000, 5600), w("there", 600, 900)];
    const lv = levels(10 * S, [[0, ms(900)]]);
    expect(cleanWords(words, lv).map((x) => x.text)).toEqual(["Hello", "there"]);
  });

  test("keeps every word without levels", () => {
    const words = [w("a", 0, 100)];
    expect(cleanWords(words, null)).toBe(words);
  });
});

describe("isPureFiller", () => {
  const one = (text: string, lenMs = 300, gap = 300 * 1000) => isPureFiller(w(text, 0, lenMs), gap, gap);
  test("knows the pure list in both languages", () => {
    for (const t of ["um", "Umm,", "uh", "erm", "hmm", "ã", "ããã", "hum", "ahn", "éé"]) expect(one(t)).toBe(true);
    for (const t of ["tipo", "né", "like", "so", "então", "Marz", "humano"]) expect(one(t)).toBe(false);
  });
  test("a lone é needs length and pauses", () => {
    expect(one("é", 450)).toBe(true);
    expect(one("é", 300)).toBe(false);
    expect(one("é", 450, 50_000)).toBe(false);
  });
});

describe("levelCuts", () => {
  test("cuts quiet stretches from levels alone", () => {
    const lv = levels(6 * S, [[0, S], [ms(3000), ms(4000)]]);
    const cuts = levelCuts(lv, { ...opts, durationUs: 6 * S });
    expect(cuts).toEqual([
      { startUs: ms(1300), endUs: ms(2700), reason: "silence", fromWordId: "t1000", toWordId: "t3000" },
      { startUs: ms(4300), endUs: 6 * S, reason: "silence", fromWordId: "t4000", toWordId: "t6000" },
    ]);
  });
});
