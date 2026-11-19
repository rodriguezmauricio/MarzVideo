import { captionEdits, captionStyleFor, parseProject, serializeProject, type Project } from "@marz/format";
import { describe, expect, test } from "vitest";
import { setCaptionBreak, setCaptionStyle, setCaptionText, touchedRanges } from "./commands";
import { History } from "./history";

const base = (captions?: unknown): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 60_000_000,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: captions === undefined ? {} : { captions },
  });

describe("caption splits and joins", () => {
  test("split is one undo step", () => {
    const h = new History(base());
    h.apply(setCaptionBreak("w5", "split"));
    expect(captionEdits(h.current).breaks).toEqual({ w5: "split" });
    h.undo();
    expect(h.current.edits.captions).toBeUndefined();
  });

  test("join replaces a split; null removes it; no change returns the same project", () => {
    let p = setCaptionBreak("w5", "split")(base());
    p = setCaptionBreak("w5", "join")(p);
    expect(captionEdits(p).breaks).toEqual({ w5: "join" });
    expect(setCaptionBreak("w5", "join")(p)).toBe(p);
    p = setCaptionBreak("w5", null)(p);
    expect(captionEdits(p).breaks).toEqual({});
    expect(setCaptionBreak("w5", null)(p)).toBe(p);
  });

  test("editing keeps break values this build does not know", () => {
    const p = setCaptionBreak("w1", "split")(base({ overrides: {}, hidden: [], breaks: { w9: "wobble" } }));
    expect(JSON.parse(serializeProject(p)).edits.captions.breaks).toEqual({ w9: "wobble", w1: "split" });
    const q = setCaptionText("w2", "Hi")(base({ overrides: {}, hidden: [], breaks: { w9: "wobble" } }));
    expect(JSON.parse(serializeProject(q)).edits.captions.breaks).toEqual({ w9: "wobble" });
  });

  test("an M2 project fixed here writes no breaks or styles", () => {
    const p = setCaptionText("w2", "Hi")(base());
    expect(JSON.parse(serializeProject(p)).edits.captions).toEqual({ overrides: { w2: "Hi" }, hidden: [] });
  });

  test("not counted as touched ranges", () => {
    const a = base();
    expect(touchedRanges(a, setCaptionBreak("w1", "split")(a))).toEqual([]);
    expect(touchedRanges(a, setCaptionStyle("youtube", { size: "L" })(a))).toEqual([]);
  });
});

describe("caption style per preset", () => {
  test("a style change is one undo step and touches only its preset", () => {
    const h = new History(base());
    h.apply(setCaptionStyle("vertical", { position: "top", size: "L" }));
    expect(captionStyleFor(h.current, "vertical")).toEqual({ style: "plain", size: "L", position: "top", highlight: true });
    expect(captionStyleFor(h.current, "youtube")).toEqual({ style: "inkBand", size: "M", position: "bottom", highlight: false });
    h.undo();
    expect(captionStyleFor(h.current, "vertical").position).toBe("bottom");
  });

  test("setting what is already in force changes nothing", () => {
    const p = base();
    expect(setCaptionStyle("youtube", { style: "inkBand", highlight: false })(p)).toBe(p);
  });

  test("keeps unknown fields of the stored style", () => {
    const p = setCaptionStyle("youtube", { highlight: true })(base({ overrides: {}, hidden: [], styles: { youtube: { glow: 3 } } }));
    expect(JSON.parse(serializeProject(p)).edits.captions.styles.youtube).toEqual({ glow: 3, highlight: true });
  });
});
