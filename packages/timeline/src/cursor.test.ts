import { clickSettings, cursorLiveImported, cursorSections, cursorSize, parseProject, serializeProject, type CursorSection, type MarzEvent, type Project } from "@marz/format";
import { describe, expect, test } from "vitest";
import { addCursorSection, importLiveCursor, removeCursorSection, setClicks, setCursorSize, updateCursorSection } from "./cursor";
import { History } from "./history";

const S = 1_000_000;
const base = (edits: object = {}): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 60 * S,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: { zooms: [], cuts: [], cursor: { hidden: false }, clicks: { effect: "none" }, ...edits },
  });
const sec = (id: string, a: number, b: number, hide = true, clicks = false): CursorSection => ({ id, startUs: a * S, endUs: b * S, hide, clicks });
const ids = (p: Project) => cursorSections(p).map((s) => `${s.id}:${s.startUs / S}-${s.endUs / S}`);

describe("cursor sections", () => {
  test("add, trimmed to the free time after its start", () => {
    let p = addCursorSection(sec("a", 6, 8))(base());
    p = addCursorSection(sec("b", 4, 9))(p);
    p = addCursorSection(sec("c", 7, 12))(p); // starts inside a: moves to a's end
    expect(ids(p)).toEqual(["b:4-6", "a:6-8", "c:8-12"]);
  });
  test("no room: unchanged", () => {
    const p0 = addCursorSection(sec("a", 0, 60))(base());
    expect(addCursorSection(sec("b", 10, 14))(p0)).toBe(p0);
  });
  test("update keeps it between its neighbours and flips its switches", () => {
    let p = addCursorSection(sec("a", 2, 4))(base());
    p = addCursorSection(sec("b", 10, 12))(p);
    p = updateCursorSection("a", { endUs: 20 * S })(p);
    expect(ids(p)).toEqual(["a:2-10", "b:10-12"]);
    p = updateCursorSection("b", { hide: false, clicks: true })(p);
    expect(cursorSections(p)[1]).toMatchObject({ hide: false, clicks: true });
    expect(updateCursorSection("b", { hide: false })(p)).toBe(p);
  });
  test("a move keeps its length and stops at the neighbours", () => {
    let p = addCursorSection(sec("a", 2, 4))(base());
    p = addCursorSection(sec("b", 10, 12))(p);
    p = updateCursorSection("b", { startUs: 1 * S, endUs: 3 * S })(p);
    expect(ids(p)).toEqual(["a:2-4", "b:4-6"]);
  });
  test("remove, with undo through History", () => {
    const h = new History(base());
    h.apply(addCursorSection(sec("a", 2, 4)));
    h.apply(removeCursorSection("a"));
    expect(ids(h.current)).toEqual([]);
    h.undo();
    expect(ids(h.current)).toEqual(["a:2-4"]);
  });
  test("sections this build cannot read are kept", () => {
    const odd = { id: "odd", startUs: 0, endUs: S, hide: "maybe" };
    const p = addCursorSection(sec("a", 5, 6))(base({ cursor: { hidden: false, sections: [odd] } }));
    expect(JSON.parse(serializeProject(p)).edits.cursor.sections).toContainEqual(odd);
  });
});

describe("cursor size and click settings", () => {
  test("setCursorSize", () => {
    const p = setCursorSize(2)(base());
    expect(cursorSize(p)).toBe(2);
    expect(setCursorSize(2)(p)).toBe(p);
    expect(p.edits.cursor.hidden).toBe(false);
  });
  test("setClicks on, style, colour, size; off keeps the style", () => {
    let p = setClicks({ on: true })(base());
    expect(clickSettings(p)).toEqual({ on: true, style: "ripple", color: "accent", size: "M" });
    expect(p.edits.clicks.effect).toBe("ripple");
    p = setClicks({ style: "ring", color: "ink", size: "L" })(p);
    expect(clickSettings(p)).toEqual({ on: true, style: "ring", color: "ink", size: "L" });
    p = setClicks({ on: false })(p);
    expect(p.edits.clicks.effect).toBe("none");
    expect(clickSettings(p)).toEqual({ on: false, style: "ring", color: "ink", size: "L" });
    expect(setClicks({ on: false })(p)).toBe(p);
  });
});

describe("importLiveCursor (live hide cursor)", () => {
  const ev = (t: number, hidden: boolean): MarzEvent => ({ tUs: Math.round(t * S), type: "cursorHidden", hidden });
  const blocks = (p: Project) => cursorSections(p).map((s) => `${s.id}:${s.startUs / S}-${s.endUs / S}:${s.hide ? "hide" : "show"}:${s.clicks ? "clicks" : "-"}`);

  test("hidden stretches become hide blocks; one open at Stop runs to the end; repeats ignored", () => {
    const p = importLiveCursor([ev(5, true), ev(6, true), ev(9, false), ev(9.5, false), ev(40, true)])(base());
    expect(blocks(p)).toEqual(["live-cursor-1:5-9:hide:-", "live-cursor-2:40-60:hide:-"]);
    expect(cursorLiveImported(p)).toBe(true);
  });
  test("starting hidden (setup toggle): shown stretches become show blocks", () => {
    const p = importLiveCursor([ev(10, false), ev(20, true)])(base({ cursor: { hidden: true } }));
    expect(blocks(p)).toEqual(["live-cursor-1:10-20:show:-"]);
  });
  test("copies the video's click effects, drops blocks under 0.1 s, keeps lines in any order", () => {
    const p = importLiveCursor([ev(12, false), ev(3.05, false), ev(11, true), ev(3, true)])(base({ clicks: { effect: "ripple" } }));
    expect(blocks(p)).toEqual(["live-cursor-2:11-12:hide:clicks"]);
  });
  test("once only; nothing to import leaves the project alone", () => {
    const p0 = base();
    expect(importLiveCursor([])(p0)).toBe(p0);
    const p1 = importLiveCursor([ev(5, true)])(p0);
    expect(importLiveCursor([ev(30, true)])(p1)).toBe(p1);
    const saved = parseProject(JSON.parse(serializeProject(p1)));
    expect(importLiveCursor([ev(30, true)])(saved)).toBe(saved);
  });
  test("a baked cursor gets no blocks but is marked", () => {
    const baked = parseProject({ ...JSON.parse(serializeProject(base())), source: { width: 1920, height: 1080, fps: 30, cursor: "baked" } });
    const p = importLiveCursor([ev(5, true)])(baked);
    expect(blocks(p)).toEqual([]);
    expect(cursorLiveImported(p)).toBe(true);
  });
});
