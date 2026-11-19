import { aiEdits, captionEdits, DEFAULT_AI_EDITS, parseProject, type Cut, type Project, type Zoom } from "@marz/format";
import { describe, expect, test } from "vitest";
import {
  addCut,
  addZoom,
  applyAiPass,
  removeCut,
  removeZoom,
  replaceAutoZooms,
  setAiKinds,
  setAiPace,
  setCaptionHidden,
  setCaptionText,
  touchedRanges,
  updateCut,
  updateZoom,
} from "./commands";
import { History } from "./history";

const S = 1_000_000;
const zoom = (id: string, origin: Zoom["origin"], a: number, b: number, extra: Partial<Zoom> = {}): Zoom => ({
  id, startUs: a * S, endUs: b * S, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
  easeInUs: 400_000, easeOutUs: 400_000, easing: "easeInOutCubic", origin, ...extra,
});
const aiCut = (id: string, a: number, b: number, from = "w1", to = "w2"): Cut =>
  ({ id, startUs: a * S, endUs: b * S, origin: "ai", reason: "silence", fromWordId: from, toWordId: to }) as Cut;
const manualCut = (id: string, a: number, b: number): Cut => ({ id, startUs: a * S, endUs: b * S });

const base = (): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-15T00:00:00Z", durationUs: 60 * S,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: { zooms: [], cuts: [], cursor: { hidden: false }, clicks: { effect: "none" } },
  });

const meta = (result: unknown = { mistakes: [], contextFillers: [], zooms: [] }) => ({
  at: "2026-11-19T00:00:00Z", provider: "fake", model: "fixture", languages: ["pt"], result,
});
const none = { touchedSince: [] };
const pass = (cuts: Cut[], zooms: Zoom[] = []) => ({ cuts, zooms });

describe("applyAiPass", () => {
  test("one pass is one undo step", () => {
    const h = new History(base());
    h.apply(applyAiPass(pass([aiCut("a", 1, 2), aiCut("b", 5, 6)], [zoom("z", "ai", 10, 12)]), none, meta()));
    expect(h.current.edits.cuts).toHaveLength(2);
    expect(h.current.edits.zooms).toHaveLength(1);
    h.undo();
    expect(h.canUndo).toBe(false);
  });

  test("undo after a pass restores the project exactly", () => {
    const h = new History(addCut(manualCut("m", 30, 31))(base()));
    const before = h.current;
    h.apply(applyAiPass(pass([aiCut("a", 1, 2)]), none, meta()));
    h.undo();
    expect(h.current).toBe(before);
  });

  test("records the run and the result", () => {
    const r = { mistakes: [], contextFillers: ["w3"], zooms: [] };
    const p = applyAiPass(pass([]), none, meta(r))(base());
    expect(aiEdits(p).lastRun).toEqual({ at: "2026-11-19T00:00:00Z", provider: "fake", model: "fixture", languages: ["pt"] });
    expect(aiEdits(p).lastResult).toEqual(r);
    expect(aiEdits(p).paceUs).toBe(DEFAULT_AI_EDITS.paceUs);
  });

  test("rerun keeps manual edits and replaces ai ones", () => {
    let p = applyAiPass(pass([aiCut("a", 1, 2), aiCut("b", 5, 6)]), none, meta())(base());
    p = addCut(manualCut("m", 20, 21))(p);
    p = applyAiPass(pass([aiCut("c", 8, 9)]), none, meta({ mistakes: [], contextFillers: [], zooms: [], v: 2 }))(p);
    expect(p.edits.cuts.map((c) => c.id).sort()).toEqual(["c", "m"]);
  });

  test("a new ai cut over a manual cut is dropped", () => {
    let p = addCut(manualCut("m", 1, 3))(base());
    p = applyAiPass(pass([aiCut("a", 2, 4), aiCut("b", 10, 11)]), none, meta())(p);
    expect(p.edits.cuts.map((c) => c.id).sort()).toEqual(["b", "m"]);
  });

  test("tweaking an ai zoom makes it manual", () => {
    let p = applyAiPass(pass([], [zoom("z", "ai", 10, 12, { candidateId: "k1" })]), none, meta())(base());
    expect(updateZoom("z", { startUs: 10 * S })(p)).toBe(p); // same value: no change
    p = updateZoom("z", { startUs: 9 * S })(p);
    expect(p.edits.zooms[0]!.origin).toBe("manual");
    p = applyAiPass(pass([], [zoom("z2", "ai", 10, 13)]), none, meta({ again: 1 }))(p);
    expect(p.edits.zooms.map((z) => z.id)).toEqual(["z"]); // the new one overlapped his zoom
  });

  test("trimming an ai cut makes it manual", () => {
    let p = applyAiPass(pass([aiCut("a", 1, 2)]), none, meta())(base());
    p = updateCut("a", { endUs: 2.5 * S })(p);
    expect(p.edits.cuts[0]!.origin).toBe("manual");
  });

  test("deleting an ai cut records it as rejected and undo removes the record", () => {
    const h = new History(applyAiPass(pass([aiCut("a", 1, 2, "w4", "w5")]), none, meta())(base()));
    h.apply(removeCut("a"));
    expect(aiEdits(h.current).rejected).toEqual([{ kind: "cut", reason: "silence", fromWordId: "w4", toWordId: "w5" }]);
    h.undo();
    expect(aiEdits(h.current).rejected).toEqual([]);
    expect(h.current.edits.cuts).toHaveLength(1);
  });

  test("deleting an ai zoom rejects its candidate; deleting a manual one records nothing", () => {
    let p = applyAiPass(pass([], [zoom("z", "ai", 10, 12, { candidateId: "k2" })]), none, meta())(base());
    p = addZoom(zoom("m", "manual", 30, 32))(p);
    p = removeZoom("m")(removeZoom("z")(p));
    expect(aiEdits(p).rejected).toEqual([{ kind: "zoom", candidateId: "k2" }]);
  });

  test("edits during the run win", () => {
    const snapshot = base();
    const now = addCut(manualCut("his", 4, 5))(snapshot); // he cut while the pass ran
    const touched = touchedRanges(snapshot, now);
    expect(touched).toEqual([{ startUs: 4 * S, endUs: 5 * S }]);
    const p = applyAiPass(pass([aiCut("overlap", 4.5, 6), aiCut("ok", 10, 11)]), { touchedSince: touched }, meta())(now);
    expect(p.edits.cuts.map((c) => c.id).sort()).toEqual(["his", "ok"]);
  });

  test("a range he removed during the run also blocks ai edits there", () => {
    const snapshot = addZoom(zoom("m", "manual", 20, 22))(base());
    const now = removeZoom("m")(snapshot);
    const p = applyAiPass(pass([], [zoom("ai", "ai", 21, 23)]), { touchedSince: touchedRanges(snapshot, now) }, meta())(now);
    expect(p.edits.zooms).toEqual([]);
  });

  test("ai pass replaces untouched auto zooms", () => {
    let p = addZoom(zoom("auto-1", "auto", 30, 32))(base());
    p = addZoom(zoom("auto-2", "auto", 40, 42))(p);
    p = updateZoom("auto-2", { endUs: 43 * S })(p); // tweaked: now his
    p = applyAiPass(pass([], [zoom("ai-zoom-k1", "ai", 30, 33)]), none, meta())(p);
    expect(p.edits.zooms.map((z) => `${z.id}:${z.origin}`).sort()).toEqual(["ai-zoom-k1:ai", "auto-2:manual"]);
  });

  test("pressing A later replaces only auto zooms and skips clusters overlapping ai zooms", () => {
    let p = applyAiPass(pass([], [zoom("ai-zoom-k1", "ai", 10, 12)]), none, meta())(base());
    p = addZoom(zoom("auto-old", "auto", 50, 52))(p);
    p = replaceAutoZooms([zoom("auto-1", "auto", 11, 13), zoom("auto-2", "auto", 20, 22)])(p);
    expect(p.edits.zooms.map((z) => z.id).sort()).toEqual(["ai-zoom-k1", "auto-2"]);
  });

  test("pass with identical result adds no undo step", () => {
    const h = new History(base());
    const run = () => h.apply(applyAiPass(pass([aiCut("a", 1, 2)]), none, meta()));
    run();
    const after = h.current;
    run();
    expect(h.current).toBe(after);
    h.undo();
    expect(h.canUndo).toBe(false);
  });
});

describe("pace and kinds", () => {
  test("setAiPace swaps only ai cuts and stores the pace", () => {
    let p = applyAiPass(pass([aiCut("a", 1, 3)]), none, meta())(base());
    p = addCut(manualCut("m", 20, 21))(p);
    p = setAiPace(80_000, { cuts: [aiCut("a", 0.8, 3.2)] })(p);
    expect(aiEdits(p).paceUs).toBe(80_000);
    expect(p.edits.cuts.find((c) => c.id === "a")!.startUs).toBe(0.8 * S);
    expect(p.edits.cuts.some((c) => c.id === "m")).toBe(true);
    expect(setAiPace(80_000, { cuts: [aiCut("a", 0.8, 3.2)] })(p)).toBe(p);
  });

  test("setAiKinds stores the toggles and swaps ai edits", () => {
    let p = applyAiPass(pass([aiCut("a", 1, 3)], [zoom("z", "ai", 10, 12)]), none, meta())(base());
    const kinds = { ...DEFAULT_AI_EDITS.kinds, zooms: false };
    p = setAiKinds(kinds, { cuts: [aiCut("a", 1, 3)], zooms: [] })(p);
    expect(aiEdits(p).kinds.zooms).toBe(false);
    expect(p.edits.zooms).toEqual([]);
  });
});

describe("caption fixes", () => {
  test("caption override is one undo step", () => {
    const h = new History(base());
    h.apply(setCaptionText("w12", "Marz"));
    expect(captionEdits(h.current).overrides).toEqual({ w12: "Marz" });
    h.undo();
    expect(h.current.edits.captions).toBeUndefined();
  });

  test("clearing the text removes the override", () => {
    let p = setCaptionText("w12", "Marz")(base());
    p = setCaptionText("w12", null)(p);
    expect(captionEdits(p).overrides).toEqual({});
    expect(setCaptionText("w12", null)(p)).toBe(p);
  });

  test("hide and unhide a word", () => {
    let p = setCaptionHidden("w3", true)(base());
    expect(captionEdits(p).hidden).toEqual(["w3"]);
    expect(setCaptionHidden("w3", true)(p)).toBe(p);
    p = setCaptionHidden("w3", false)(p);
    expect(captionEdits(p).hidden).toEqual([]);
  });

  test("caption changes are not counted as touched ranges", () => {
    const a = base();
    expect(touchedRanges(a, setCaptionText("w1", "x")(a))).toEqual([]);
  });
});
