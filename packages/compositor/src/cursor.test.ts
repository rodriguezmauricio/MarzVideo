import { parseProject, type MarzEvent, type Project } from "@marz/format";
import { describe, expect, test } from "vitest";
import { clickEffectsAt, cursorAt } from "./cursor";
import { frameAt } from "./frame";

const S = 1_000_000;
const project = (edits: object = {}, source: object = {}): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20 * S,
    source: { width: 1920, height: 1080, fps: 60, ...source },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 60 },
    edits: { zooms: [], cuts: [], cursor: { hidden: false }, clicks: { effect: "none" }, ...edits },
  });
const cur = (tUs: number, x: number, y: number): MarzEvent => ({ tUs, type: "cursor", x, y });
const shape = (tUs: number, s: Extract<MarzEvent, { type: "cursorShape" }>["shape"], px = 32): MarzEvent => ({ tUs, type: "cursorShape", shape: s, px });
const down = (tUs: number, x: number, y: number): MarzEvent => ({ tUs, type: "click", button: "left", state: "down", x, y });
const up = (tUs: number, x: number, y: number): MarzEvent => ({ tUs, type: "click", button: "left", state: "up", x, y });
const full = { srcRect: { sx: 0, sy: 0, sw: 1920, sh: 1080 }, dstRect: { dx: 0, dy: 0, dw: 1920, dh: 1080 } };
const at = (p: Project, ev: MarzEvent[], t: number) => cursorAt(p, ev, t, full.srcRect, full.dstRect);

describe("cursorAt", () => {
  test("arrow at 1x without shape lines, exactly at the last sample", () => {
    expect(at(project(), [cur(0, 100, 200), cur(S, 300, 400)], 1.5 * S)).toEqual({ x: 300, y: 400, shape: "arrow", scale: 1 });
  });
  test("follows shape lines and their cell size; hidden shape draws nothing; other draws the arrow", () => {
    const ev = [shape(0, "hand", 48), cur(0, 10, 10), shape(2 * S, "hidden"), shape(3 * S, "other")];
    expect(at(project(), ev, S)).toMatchObject({ shape: "hand", scale: 1.5 });
    expect(at(project(), ev, 2.5 * S)).toBeNull();
    expect(at(project(), ev, 3.5 * S)).toMatchObject({ shape: "arrow", scale: 1 });
  });
  test("size option multiplies; zoom scales like the picture", () => {
    const p = project({ cursor: { hidden: false, size: 2 } });
    expect(at(p, [cur(0, 960, 540)], S)!.scale).toBe(2);
    const zoomed = cursorAt(p, [cur(0, 960, 540)], S, { sx: 480, sy: 270, sw: 960, sh: 540 }, full.dstRect);
    expect(zoomed).toEqual({ x: 960, y: 540, shape: "arrow", scale: 4 });
  });
  test("hidden for the whole video, shown again in a block", () => {
    const p = project({ cursor: { hidden: true, sections: [{ id: "a", startUs: 2 * S, endUs: 4 * S, hide: false, clicks: false }] } });
    expect(at(p, [cur(0, 5, 5)], S)).toBeNull();
    expect(at(p, [cur(0, 5, 5)], 3 * S)).not.toBeNull();
  });
  test("hidden in a block only", () => {
    const p = project({ cursor: { hidden: false, sections: [{ id: "a", startUs: 2 * S, endUs: 4 * S, hide: true, clicks: true }] } });
    expect(at(p, [cur(0, 5, 5)], 3 * S)).toBeNull();
    expect(at(p, [cur(0, 5, 5)], 4 * S)).not.toBeNull();
  });
  test("a baked recording never draws the cursor", () => {
    expect(at(project({}, { cursor: "baked" }), [cur(0, 5, 5)], S)).toBeNull();
  });
});

describe("clickEffectsAt", () => {
  const on = (style: string, extra: object = {}) => project({ clicks: { effect: style, color: "paper", size: "M" }, ...extra });
  const fx = (p: Project, ev: MarzEvent[], t: number) => clickEffectsAt(p, ev, t, full.srcRect, full.dstRect);
  test("off: nothing", () => {
    expect(fx(project(), [down(S, 10, 10)], S + 100_000)).toEqual([]);
  });
  test("ripple grows and fades over 500 ms", () => {
    const ev = [down(S, 100, 100), up(S + 80_000, 100, 100)];
    expect(fx(on("ripple"), ev, S - 1)).toEqual([]);
    const a = fx(on("ripple"), ev, S)[0]!;
    const b = fx(on("ripple"), ev, S + 250_000)[0]!;
    expect(a).toMatchObject({ x: 100, y: 100, fill: false, color: "paper", alpha: 1 });
    expect(a.r).toBeCloseTo(0.25 * 24);
    expect(b.r).toBeGreaterThan(a.r);
    expect(b.alpha).toBeCloseTo(0.5);
    expect(fx(on("ripple"), ev, S + 500_000)).toEqual([]);
  });
  test("pulse is a fading disc over 400 ms", () => {
    const e = fx(on("pulse"), [down(S, 100, 100)], S + 200_000)[0]!;
    expect(e.fill).toBe(true);
    expect(e.alpha).toBeCloseTo(0.225);
    expect(fx(on("pulse"), [down(S, 100, 100)], S + 400_000)).toEqual([]);
  });
  test("ring holds from press to release, at least 250 ms", () => {
    const ev = [down(S, 100, 100), up(S + 50_000, 100, 100), down(3 * S, 50, 50), up(4 * S, 50, 50)];
    expect(fx(on("ring"), ev, S + 200_000)[0]).toMatchObject({ r: 24, alpha: 1, fill: false });
    expect(fx(on("ring"), ev, S + 250_000)).toEqual([]);
    expect(fx(on("ring"), ev, 3.9 * S)[0]).toMatchObject({ x: 50, y: 50 });
    expect(fx(on("ring"), ev, 4 * S)).toEqual([]);
  });
  test("size, cell size and zoom scale the effect; outside the zoom draws nothing", () => {
    const p = project({ clicks: { effect: "ring", size: "L" } });
    const ev = [shape(0, "arrow", 48), down(S, 960, 540)];
    expect(clickEffectsAt(p, ev, S, { sx: 480, sy: 270, sw: 960, sh: 540 }, full.dstRect)[0]!.r).toBeCloseTo(0.75 * 48 * 1.4 * 2);
    expect(clickEffectsAt(p, [down(S, 100, 100)], S, { sx: 480, sy: 270, sw: 960, sh: 540 }, full.dstRect)).toEqual([]);
  });
  test("a block turns effects off or on by the press time", () => {
    const sections = [{ id: "a", startUs: 0, endUs: 2 * S, hide: false, clicks: false }];
    expect(fx(on("ring", { cursor: { hidden: false, sections } }), [down(S, 1, 1)], S + 1)).toEqual([]);
    const onlyIn = project({ cursor: { hidden: false, sections: [{ ...sections[0]!, clicks: true }] }, clicks: { effect: "none", style: "pulse" } });
    expect(fx(onlyIn, [down(S, 1, 1)], S + 1)[0]).toMatchObject({ fill: true, color: "accent" });
  });
  test("frameAt carries cursor and clicks", () => {
    const f = frameAt(on("ring"), [cur(0, 100, 100), down(S, 100, 100)], S + 1);
    expect(f.cursor).toMatchObject({ x: 100, y: 100 });
    expect(f.clicks).toHaveLength(1);
  });
});
