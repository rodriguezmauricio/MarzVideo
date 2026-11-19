import { DEFAULT_AI_EDITS, parseProject, type MarzEvent, type Project, type Word } from "@marz/format";
import { describe, expect, test } from "vitest";
import type { AiResult, ZoomCandidate } from "./ai/types";
import { buildAiEdits, zoomCandidates } from "./build";

const ms = (n: number) => n * 1000;
const W = (id: string, text: string, a: number, b: number): Word => ({ id, text, startUs: ms(a), endUs: ms(b), p: 0.9 });

// "one [2 s] two umm three. four four again"
const words: Word[] = [
  W("w1", "one", 0, 400),
  W("w2", "two", 2400, 2800),
  W("w3", "umm", 2900, 3300),
  W("w4", "three.", 3400, 3800),
  W("w5", "tipo", 3900, 4200),
  W("w6", "four", 4300, 4600),
  W("w7", "four", 4700, 5000),
  W("w8", "again", 5100, 5500),
];

function project(ai: Partial<typeof DEFAULT_AI_EDITS> = {}): Project {
  return parseProject({
    version: 1,
    id: "p",
    name: "t",
    createdAt: "2026-11-19T00:00:00Z",
    durationUs: ms(5500),
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: { ai: { ...DEFAULT_AI_EDITS, ...ai } },
  });
}

const candidates: ZoomCandidate[] = [{ id: "k1", startUs: ms(4000), endUs: ms(5200), rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }];
const result: AiResult = {
  mistakes: [{ fromWordId: "w6", toWordId: "w6", why: "repeated take" }],
  contextFillers: ["w5"],
  zooms: [{ candidateId: "k1", fromWordId: "w6", toWordId: "w8" }],
};
const run = (p: Project, ai: AiResult | null = null) => buildAiEdits({ project: p, words, levels: null, candidates, ai });

describe("buildAiEdits", () => {
  test("rule cuts become ai cuts with reasons", () => {
    const { cuts, zooms } = run(project());
    expect(cuts.map((c) => c.reason)).toEqual(["silence", "filler"]);
    expect(cuts.every((c) => c.origin === "ai")).toBe(true);
    expect(cuts[0]).toMatchObject({ startUs: ms(700), endUs: ms(2100), fromWordId: "w1", toWordId: "w2" });
    expect(zooms).toEqual([]);
  });

  test("kinds off removes that kind", () => {
    const p = project({ kinds: { ...DEFAULT_AI_EDITS.kinds, silences: false, mistakes: false, zooms: false } });
    const { cuts, zooms } = run(p, result);
    expect(cuts.map((c) => c.reason)).toEqual(["filler", "filler"]);
    expect(zooms).toEqual([]);
  });

  test("rejected silence stays out by word ids even after pace changes", () => {
    const rejected = [{ kind: "cut" as const, reason: "silence" as const, fromWordId: "w1", toWordId: "w2" }];
    for (const paceUs of [ms(80), ms(300), ms(600)]) {
      const { cuts } = run(project({ paceUs, rejected }));
      expect(cuts.some((c) => c.reason === "silence")).toBe(false);
    }
  });

  test("rejected zoom candidate stays out", () => {
    const { zooms } = run(project({ rejected: [{ kind: "zoom", candidateId: "k1" }] }), result);
    expect(zooms).toEqual([]);
  });

  test("ai mistake range becomes a mistake cut", () => {
    const { cuts } = run(project(), result);
    const m = cuts.find((c) => c.reason === "mistake");
    expect(m).toMatchObject({ startUs: ms(4300), endUs: ms(4600), fromWordId: "w6", toWordId: "w6", origin: "ai" });
    expect(cuts.find((c) => c.fromWordId === "w5")?.reason).toBe("filler");
  });

  test("ai zoom uses the candidate rect and word times", () => {
    const { zooms } = run(project(), result);
    expect(zooms).toEqual([
      {
        id: "ai-zoom-k1",
        startUs: ms(4300),
        endUs: ms(5500),
        rect: candidates[0]!.rect,
        easeInUs: 400_000,
        easeOutUs: 400_000,
        easing: "easeInOutCubic",
        origin: "ai",
        candidateId: "k1",
      },
    ]);
  });

  test("ai items with unknown ids are ignored", () => {
    const bad: AiResult = { mistakes: [{ fromWordId: "x", toWordId: "w2", why: "" }], contextFillers: ["nope"], zooms: [{ candidateId: "k9", fromWordId: "w1", toWordId: "w2" }] };
    const { cuts, zooms } = run(project(), bad);
    expect(cuts.map((c) => c.reason)).toEqual(["silence", "filler"]);
    expect(zooms).toEqual([]);
  });

  test("no ai result gives rule cuts only and no zooms", () => {
    const { cuts, zooms } = run(project(), null);
    expect(cuts.every((c) => c.reason !== "mistake")).toBe(true);
    expect(zooms).toEqual([]);
  });
});

describe("zoomCandidates", () => {
  test("numbers click clusters by start time", () => {
    const click = (t: number, x: number): MarzEvent => ({ type: "click", tUs: t, button: "left", state: "down", x, y: 300 });
    const events = [click(ms(10_000), 900), click(ms(10_300), 910), click(ms(1000), 100), click(ms(1300), 110)];
    const c = zoomCandidates(events, project());
    expect(c.map((x) => x.id)).toEqual(["k1", "k2"]);
    expect(c[0]!.startUs).toBeLessThan(c[1]!.startUs);
  });
});
