import { describe, expect, it } from "vitest";
import type { MarzEvent, Zoom } from "@marz/format";
import { AIM, aimAt, aimPathAt, autoAim, cropRectAt, windowWidth } from "./reframe";

const SRC = { width: 1920, height: 1080 };
const D = 20_000_000;
const W = windowWidth(SRC); // 0.3164
const HW = W / 2;
const cur = (tUs: number, xn: number, yn = 0.5): MarzEvent => ({ tUs, type: "cursor", x: xn * SRC.width, y: yn * SRC.height });
const click = (tUs: number, xn: number, yn = 0.5): MarzEvent => ({ tUs, type: "click", button: "left", state: "down", x: xn * SRC.width, y: yn * SRC.height });
const zoom = (startUs: number, endUs: number, rect: Zoom["rect"]): Zoom => ({ id: `z${startUs}`, startUs, endUs, rect, easeInUs: 0, easeOutUs: 0, easing: "linear", origin: "manual" });

/** The cursor glides from x0 to x1 over [t0, t1] in 50 ms steps. */
const glide = (t0: number, t1: number, x0: number, x1: number): MarzEvent[] => {
  const out: MarzEvent[] = [];
  for (let t = t0; t <= t1; t += 50_000) out.push(cur(t, x0 + ((x1 - x0) * (t - t0)) / (t1 - t0)));
  return out;
};

describe("windowWidth", () => {
  it("is a full-height 9:16 window as a share of the screen width", () => {
    expect(W).toBeCloseTo((1080 * 9) / 16 / 1920, 6);
  });
});

describe("autoAim", () => {
  it("without events holds the centre", () => {
    expect(autoAim([], SRC, D, [])).toEqual({ x0: 0.5, moves: [] });
  });

  it("a cursor resting in one place: starts there, never moves", () => {
    const p = autoAim([cur(0, 0.3), cur(5_000_000, 0.305)], SRC, D, []);
    expect(p.x0).toBeCloseTo(0.3, 2);
    expect(p.moves).toEqual([]);
  });

  it("starts clamped so the window stays inside the screen", () => {
    expect(autoAim([cur(0, 0.02)], SRC, D, []).x0).toBeCloseTo(HW, 6);
    expect(autoAim([cur(0, 0.99)], SRC, D, []).x0).toBeCloseTo(1 - HW, 6);
  });

  it("two rests far apart: one eased move that arrives when the second rest starts", () => {
    const ev = [cur(0, 0.2), ...glide(4_000_000, 5_000_000, 0.2, 0.8), cur(9_000_000, 0.8)];
    const p = autoAim(ev, SRC, D, []);
    expect(p.moves).toHaveLength(1);
    const m = p.moves[0]!;
    expect(m.endUs).toBe(5_000_000);
    expect(m.endUs - m.startUs).toBe(AIM.MOVE_US);
    expect(m.fromX).toBeCloseTo(0.2, 2);
    expect(m.toX).toBeCloseTo(0.8, 2);
  });

  it("small moves inside the dead zone keep the window still", () => {
    const ev = [cur(0, 0.5), ...glide(1_000_000, 2_000_000, 0.5, 0.5 + HW * 0.5), cur(4_000_000, 0.5 + HW * 0.5), ...glide(5_000_000, 6_000_000, 0.5 + HW * 0.5, 0.5 - HW * 0.5), cur(8_000_000, 0.5 - HW * 0.5)];
    expect(autoAim(ev, SRC, D, []).moves).toEqual([]);
  });

  it("a quick flick out and back (no rest, no click) does not move the window", () => {
    const ev = [cur(0, 0.5), ...glide(2_000_000, 2_200_000, 0.5, 0.9), ...glide(2_250_000, 2_450_000, 0.9, 0.5), cur(6_000_000, 0.5)];
    expect(autoAim(ev, SRC, D, []).moves).toEqual([]);
  });

  it("a click far away is framed when it happens (the move starts before it)", () => {
    const ev = [cur(0, 0.2), cur(3_000_000, 0.75), click(3_000_000, 0.75), cur(3_100_000, 0.76)];
    const p = autoAim(ev, SRC, D, []);
    expect(p.moves[0]!.endUs).toBe(3_000_000);
    expect(p.moves[0]!.toX).toBeCloseTo(0.75, 2);
  });

  it("moves are at least the minimum hold apart and never overlap", () => {
    const ev = [cur(0, 0.2), click(2_000_000, 0.8), click(2_300_000, 0.2), click(2_600_000, 0.8)];
    const p = autoAim(ev, SRC, D, []);
    expect(p.moves.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < p.moves.length; i++) {
      expect(p.moves[i]!.startUs - p.moves[i - 1]!.endUs).toBeGreaterThanOrEqual(AIM.MIN_HOLD_US);
      expect(p.moves[i]!.endUs - p.moves[i]!.startUs).toBeGreaterThanOrEqual(AIM.MIN_MOVE_US);
      expect(p.moves[i]!.fromX).toBe(p.moves[i - 1]!.toX);
    }
  });

  it("a zoom start aims at the zoom", () => {
    const z = zoom(6_000_000, 9_000_000, { x: 0.6, y: 0.1, w: 0.3, h: 0.3 });
    const p = autoAim([cur(0, 0.2)], SRC, D, [z]);
    expect(p.moves[0]!.endUs).toBe(6_000_000);
    expect(p.moves[0]!.toX).toBeCloseTo(0.75, 2);
    // The cursor outside the zoom area does not pull the window out while the zoom is on; after it the
    // window goes back to the resting cursor.
    expect(p.moves.slice(1).every((m) => m.startUs >= 9_000_000)).toBe(true);
    expect(p.moves[p.moves.length - 1]!.toX).toBeCloseTo(0.2, 2);
  });

  it("the cursor staying outside the window for a while is followed (excursion)", () => {
    // Keeps moving (never rests) between 0.75 and 0.85 for 3 s.
    const wig: MarzEvent[] = [];
    for (let t = 2_000_000; t <= 5_000_000; t += 100_000) wig.push(cur(t, (t / 100_000) % 2 === 0 ? 0.75 : 0.85, (t / 100_000) % 3 === 0 ? 0.3 : 0.6));
    const p = autoAim([cur(0, 0.2), ...wig], SRC, D, []);
    expect(p.moves).toHaveLength(1);
    expect(p.moves[0]!.toX).toBeCloseTo(0.8, 1);
    expect(p.moves[0]!.endUs).toBeLessThanOrEqual(2_000_000 + AIM.EXCURSION_LEAD_US);
  });
});

describe("aimPathAt", () => {
  const path = { x0: 0.2, moves: [{ startUs: 1_000_000, endUs: 2_000_000, fromX: 0.2, toX: 0.6 }] };
  it("holds before and after a move, eases through it", () => {
    expect(aimPathAt(path, 0)).toBe(0.2);
    expect(aimPathAt(path, 1_000_000)).toBeCloseTo(0.2, 6);
    expect(aimPathAt(path, 1_500_000)).toBeCloseTo(0.4, 6);
    expect(aimPathAt(path, 1_250_000)).toBeLessThan(0.3); // eased, not linear
    expect(aimPathAt(path, 2_000_000)).toBe(0.6);
    expect(aimPathAt(path, 9_000_000)).toBe(0.6);
  });
});

describe("aimAt with Frame blocks", () => {
  const path = { x0: 0.3, moves: [] };
  const holds = [{ id: "f", startUs: 2_000_000, endUs: 6_000_000, x: 0.7 }];
  it("his block wins inside, eases in and out over 0.4 s, auto outside", () => {
    expect(aimAt(path, holds, 1_000_000)).toBe(0.3);
    expect(aimAt(path, holds, 2_000_000)).toBeCloseTo(0.3, 6);
    expect(aimAt(path, holds, 2_200_000)).toBeCloseTo(0.5, 6);
    expect(aimAt(path, holds, 2_400_000)).toBeCloseTo(0.7, 6);
    expect(aimAt(path, holds, 4_000_000)).toBe(0.7);
    expect(aimAt(path, holds, 5_800_000)).toBeCloseTo(0.5, 6);
    expect(aimAt(path, holds, 6_000_000)).toBe(0.3);
  });
  it("a short block eases over half its length", () => {
    const short = [{ id: "s", startUs: 1_000_000, endUs: 1_400_000, x: 0.9 }];
    expect(aimAt(path, short, 1_200_000)).toBeCloseTo(0.9, 6);
  });
});

describe("cropRectAt", () => {
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const AR = 9 / 16;
  it("full height, 9:16 wide, centred on the aim", () => {
    const r = cropRectAt(0.5, FULL, SRC, AR);
    expect(r.h).toBe(1);
    expect(r.y).toBe(0);
    expect(r.w).toBeCloseTo(W, 6);
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 6);
  });
  it("clamps to the screen edges", () => {
    expect(cropRectAt(0, FULL, SRC, AR).x).toBe(0);
    const r = cropRectAt(1, FULL, SRC, AR);
    expect(r.x + r.w).toBeCloseTo(1, 9);
  });
  it("inside a zoom: the zoom's height and top, kept inside the zoom area", () => {
    const z = { x: 0.5, y: 0.2, w: 0.4, h: 0.4 };
    const r = cropRectAt(0.1, z, SRC, AR);
    expect(r.h).toBeCloseTo(0.4, 9);
    expect(r.y).toBeCloseTo(0.2, 9);
    expect(r.w).toBeCloseTo(W * 0.4, 6);
    expect(r.x).toBeCloseTo(0.5, 9);
  });
  it("a box wider than the zoom fits the zoom's width instead", () => {
    const z = { x: 0.5, y: 0.2, w: 0.1, h: 0.4 };
    const r = cropRectAt(0.55, z, SRC, 2);
    expect(r.w).toBeCloseTo(0.1, 9);
    expect(r.x).toBeCloseTo(0.5, 9);
    expect(r.h).toBeCloseTo((0.1 * 1920) / 2 / 1080, 9);
    expect(r.y + r.h / 2).toBeCloseTo(0.4, 9);
  });
});
