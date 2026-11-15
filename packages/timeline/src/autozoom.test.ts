import { describe, expect, test } from "vitest";
import type { ClickEvent, MarzEvent } from "@marz/format";
import { suggestZooms } from "./autozoom";

const source = { width: 1920, height: 1080 };
const A = 16 / 9;
const down = (tUs: number, x: number, y: number): ClickEvent => ({ tUs, type: "click", button: "left", state: "down", x, y });
const up = (tUs: number, x: number, y: number): ClickEvent => ({ tUs, type: "click", button: "left", state: "up", x, y });
const S = 1_000_000;

describe("suggestZooms", () => {
  test("no events gives no zooms", () => {
    expect(suggestZooms([], source, A)).toEqual([]);
  });

  test("a single click is not a cluster", () => {
    expect(suggestZooms([down(2 * S, 500, 500), up(2.1 * S, 500, 500)], source, A)).toEqual([]);
  });

  test("only down clicks count", () => {
    const evs: MarzEvent[] = [up(1 * S, 500, 500), up(1.5 * S, 500, 500), up(2 * S, 500, 500)];
    expect(suggestZooms(evs, source, A)).toEqual([]);
  });

  test("three clicks in one spot give one aspect-locked zoom centered on them", () => {
    const evs = [down(4 * S, 940, 530), down(4.4 * S, 960, 540), down(4.8 * S, 980, 550)];
    const zs = suggestZooms(evs, source, A);
    expect(zs).toHaveLength(1);
    const z = zs[0]!;
    expect(z.id).toBe("auto-1");
    expect(z.origin).toBe("auto");
    expect(z.easing).toBe("easeInOutCubic");
    expect(z.easeInUs).toBe(400_000);
    expect(z.easeOutUs).toBe(400_000);
    expect(z.rect.w).toBeCloseTo(0.5);
    expect(z.rect.h).toBeCloseTo(0.5);
    expect(z.rect.x + z.rect.w / 2).toBeCloseTo(960 / 1920);
    expect(z.rect.y + z.rect.h / 2).toBeCloseTo(540 / 1080);
    expect(z.startUs).toBe(4 * S - 600_000);
    expect(z.endUs).toBe(4.8 * S + 600_000);
  });

  test("two clusters far apart give two non-overlapping zooms with increasing ids", () => {
    const evs = [down(2 * S, 300, 300), down(2.5 * S, 310, 310), down(12 * S, 1500, 800), down(12.5 * S, 1510, 810)];
    const zs = suggestZooms(evs, source, A);
    expect(zs.map((z) => z.id)).toEqual(["auto-1", "auto-2"]);
    expect(zs[0]!.endUs).toBeLessThan(zs[1]!.startUs);
  });

  test("clusters whose gap is under minGapUs merge into one zoom", () => {
    const evs = [down(1 * S, 400, 400), down(1.5 * S, 410, 410), down(3.6 * S, 420, 420), down(4.0 * S, 430, 430)];
    const zs = suggestZooms(evs, source, A, { minGapUs: 1_500_000 });
    expect(zs).toHaveLength(1);
    expect(zs[0]!.endUs).toBe(4.0 * S + 600_000);
  });

  test("clusters whose padded ranges overlap merge into one zoom", () => {
    const evs = [down(1 * S, 400, 400), down(1.5 * S, 410, 410), down(3.6 * S, 420, 420), down(4.0 * S, 430, 430)];
    const zs = suggestZooms(evs, source, A, { paddingUs: 1_500_000 });
    expect(zs).toHaveLength(1);
  });

  test("clicks far apart inside one cluster widen the rect to include them", () => {
    const evs = [down(1 * S, 100, 500), down(1.5 * S, 1800, 520)];
    const z = suggestZooms(evs, source, A)[0]!;
    expect(z.rect.x).toBeLessThanOrEqual(100 / 1920);
    expect(z.rect.x + z.rect.w).toBeGreaterThanOrEqual(1800 / 1920);
  });

  test("every suggestion is valid: positive length, rect inside the frame, start not negative", () => {
    const evs = [down(0.1 * S, 5, 5), down(0.3 * S, 1915, 1075), down(30 * S, 960, 540), down(30.2 * S, 960, 540)];
    const zs = suggestZooms(evs, source, A);
    expect(zs.length).toBeGreaterThan(0);
    for (const z of zs) {
      expect(z.endUs).toBeGreaterThan(z.startUs);
      expect(z.startUs).toBeGreaterThanOrEqual(0);
      expect(z.rect.x).toBeGreaterThanOrEqual(0);
      expect(z.rect.y).toBeGreaterThanOrEqual(0);
      expect(z.rect.x + z.rect.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(z.rect.y + z.rect.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
