import { describe, expect, it } from "vitest";
import { parseProject } from "@marz/format";
import { keyCapLabel, keysLayout, KEYS_EDGE } from "./keys";

const measure = (t: string, f: number) => t.length * f * 0.6;
const project = (keys: object) =>
  parseProject({
    version: 1,
    id: "p",
    name: "P",
    createdAt: "2026-11-19T00:00:00Z",
    durationUs: 10_000_000,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: { keys },
  });
const items = [
  { id: "k1", startUs: 1_000_000, endUs: 2_500_000, keys: ["Ctrl", "Shift", "S"], count: 1, hidden: false },
  { id: "k2", startUs: 3_000_000, endUs: 4_000_000, keys: ["Down"], count: 3, hidden: false },
  { id: "k3", startUs: 5_000_000, endUs: 6_000_000, keys: ["Enter"], count: 1, hidden: true },
];
const out = { width: 1920, height: 1080 };

describe("keysLayout", () => {
  it("draws the block at the time, nothing between blocks, nothing for hidden ones or keys off", () => {
    const p = project({ items });
    expect(keysLayout(p, 1_200_000, out, measure)?.caps.map((c) => c.label)).toEqual(["CTRL", "SHIFT", "S"]);
    expect(keysLayout(p, 2_700_000, out, measure)).toBeNull();
    expect(keysLayout(p, 5_500_000, out, measure)).toBeNull();
    expect(keysLayout(project({ items, show: false }), 1_200_000, out, measure)).toBeNull();
  });

  it("puts the plate bottom left with the edge gap by default, plus signs between caps, the count after", () => {
    const d = keysLayout(project({ items }), 1_200_000, out, measure)!;
    const gap = KEYS_EDGE * 1080;
    expect(d.plate.x).toBeCloseTo(gap);
    expect(d.plate.y + d.plate.h).toBeCloseTo(1080 - gap);
    expect(d.plus).toHaveLength(2);
    expect(d.plate.tone).toBe("ink");
    expect(d.text).toBe("paper");
    const r = keysLayout(project({ items }), 3_500_000, out, measure)!;
    expect(r.count?.text).toBe("x3");
    expect(r.count!.x).toBeGreaterThan(r.caps[0]!.x + r.caps[0]!.w);
    expect(r.count!.x + measure("x3", r.fontPx)).toBeLessThanOrEqual(r.plate.x + r.plate.w + 0.01);
  });

  it("follows position, size and style", () => {
    const d = keysLayout(project({ items, position: "topRight", size: "L", style: "accent" }), 1_200_000, out, measure)!;
    const m = keysLayout(project({ items }), 1_200_000, out, measure)!;
    expect(d.plate.y).toBeCloseTo(KEYS_EDGE * 1080);
    expect(d.plate.x + d.plate.w).toBeCloseTo(1920 - KEYS_EDGE * 1080);
    expect(d.fontPx).toBeCloseTo(m.fontPx * 1.25);
    expect(d.plate.tone).toBe("accent");
    expect(d.text).toBe("ink");
    const c = keysLayout(project({ items, position: "bottomCenter" }), 1_200_000, out, measure)!;
    expect(c.plate.x + c.plate.w / 2).toBeCloseTo(960);
  });

  it("vertical: sized on the width, inside the given safe area, never wider than it", () => {
    const area = { x: 65, y: 250, w: 950, h: 1286 };
    const d = keysLayout(project({ items }), 1_200_000, { width: 1080, height: 1920 }, measure, { area, vertical: true })!;
    expect(d.plate.x).toBeCloseTo(65);
    expect(d.plate.y + d.plate.h).toBeCloseTo(250 + 1286);
    const long = keysLayout(project({ items: [{ ...items[0], keys: ["Ctrl", "Alt", "Shift", "Win", "PrintScreen"] }], size: "L" }), 1_200_000, { width: 1080, height: 1920 }, measure, { area, vertical: true })!;
    expect(long.plate.w).toBeLessThanOrEqual(950 * 0.94 + 0.01);
  });

  it("short labels", () => {
    expect(["Delete", "PageDown", "Esc", "/"].map(keyCapLabel)).toEqual(["DEL", "PGDN", "ESC", "/"]);
  });
});
