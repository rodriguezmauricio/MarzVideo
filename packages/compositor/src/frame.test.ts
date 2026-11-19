import { describe, expect, test } from "vitest";
import { parseProject, type MarzEvent, type Project, type Zoom } from "@marz/format";
import { frameAt } from "./frame";

const zoom = (over: Partial<Zoom> = {}): Zoom => ({
  id: "z", startUs: 2_000_000, endUs: 8_000_000, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  easeInUs: 0, easeOutUs: 0, easing: "linear", origin: "manual", ...over,
});

const project = (zooms: Zoom[] = [], hidden = false): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-15T00:00:00Z", durationUs: 10_000_000,
    source: { width: 2000, height: 1000, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1000, height: 500, fps: 30 },
    edits: { zooms, cuts: [], cursor: { hidden }, clicks: { effect: "none" } },
  });

const cur = (tUs: number, x: number, y: number): MarzEvent => ({ tUs, type: "cursor", x, y });

describe("frameAt", () => {
  test("no zooms gives the full source rect", () => {
    expect(frameAt(project(), [], 1_000_000).srcRect).toEqual({ sx: 0, sy: 0, sw: 2000, sh: 1000 });
  });

  test("inside a zoom srcRect is the zoom rect in source pixels", () => {
    expect(frameAt(project([zoom()]), [], 5_000_000).srcRect).toEqual({ sx: 500, sy: 250, sw: 1000, sh: 500 });
  });

  test("cursor is the latest sample at or before the time, with no interpolation", () => {
    const evs = [cur(1_000_000, 100, 100), cur(2_000_000, 300, 300), cur(3_000_000, 900, 900)];
    expect(frameAt(project(), evs, 2_500_000).cursor).toMatchObject({ x: 150, y: 150 });
    expect(frameAt(project(), evs, 2_000_000).cursor).toMatchObject({ x: 150, y: 150 });
    expect(frameAt(project(), evs, 999_999).cursor).toBeNull();
  });

  test("cursor lookup skips non-cursor events", () => {
    const evs: MarzEvent[] = [
      cur(1_000_000, 200, 200),
      { tUs: 1_500_000, type: "click", button: "left", state: "down", x: 1, y: 1 },
    ];
    expect(frameAt(project(), evs, 2_000_000).cursor).toMatchObject({ x: 100, y: 100 });
  });

  test("cursor is mapped through the zoom rect into output pixels", () => {
    const evs = [cur(1_000_000, 1000, 500)];
    expect(frameAt(project([zoom()]), evs, 5_000_000).cursor).toMatchObject({ x: 500, y: 250 });
  });

  test("cursor outside the zoom rect is null", () => {
    const evs = [cur(1_000_000, 100, 100)];
    expect(frameAt(project([zoom()]), evs, 5_000_000).cursor).toBeNull();
  });

  test("hidden cursor setting gives null", () => {
    expect(frameAt(project([], true), [cur(1, 100, 100)], 2_000_000).cursor).toBeNull();
  });

  test("empty events gives a null cursor", () => {
    expect(frameAt(project(), [], 2_000_000).cursor).toBeNull();
  });

  test("a zoom rect outside 0 to 1 still gives a srcRect inside the source frame", () => {
    const z = zoom({ rect: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } });
    const { sx, sy, sw, sh } = frameAt(project([z]), [], 5_000_000).srcRect;
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sx + sw).toBeLessThanOrEqual(2000);
    expect(sy + sh).toBeLessThanOrEqual(1000);
  });
});

describe("frameAt letterboxing (source aspect differs from output aspect)", () => {
  const wide = (zooms: Zoom[] = []) =>
    parseProject({
      version: 1, id: "p", name: "n", createdAt: "2026-11-15T00:00:00Z", durationUs: 10_000_000,
      source: { width: 2560, height: 1600 , fps: 30 },
      tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
      output: { width: 1920, height: 1080, fps: 30 },
      edits: { zooms, cuts: [], cursor: { hidden: false }, clicks: { effect: "none" } },
    });

  test("a 16:10 source with no zoom is pillarboxed, not stretched", () => {
    const f = frameAt(wide(), [], 1_000_000);
    expect(f.dstRect).toEqual({ dx: 96, dy: 0, dw: 1728, dh: 1080 });
  });

  test("a source with the output aspect fills the output", () => {
    expect(frameAt(project(), [], 1_000_000).dstRect).toEqual({ dx: 0, dy: 0, dw: 1000, dh: 500 });
  });

  test("the cursor is placed inside the letterboxed picture", () => {
    const f = frameAt(wide(), [cur(1, 1280, 800)], 1_000_000);
    expect(f.cursor!.x).toBeCloseTo(960);
    expect(f.cursor!.y).toBeCloseTo(540);
    const corner = frameAt(wide(), [cur(1, 0, 0)], 1_000_000);
    expect(corner.cursor).toMatchObject({ x: 96, y: 0 });
  });

  test("a 16:9-wide source is letterboxed top and bottom", () => {
    const ultra = parseProject({
      version: 1, id: "p", name: "n", createdAt: "2026-11-15T00:00:00Z", durationUs: 1,
      source: { width: 3440, height: 1000, fps: 30 },
      tracks: { screen: { file: "s.mp4", offsetUs: 0 } },
      output: { width: 1920, height: 1080, fps: 30 },
    });
    const { dx, dy, dw, dh } = frameAt(ultra, [], 0).dstRect;
    expect(dx).toBe(0);
    expect(dw).toBe(1920);
    expect(dy).toBeCloseTo((1080 - dh) / 2);
    expect(dw / dh).toBeCloseTo(3.44);
  });
});
