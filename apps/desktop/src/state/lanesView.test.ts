import { describe, expect, test } from "vitest";
import { LANES_KEY, readLanesView, writeLanesView } from "./lanesView";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("lanes view memory", () => {
  test("main track by default", () => {
    expect(readLanesView(mem())).toBe(false);
  });
  test("remembers the lanes view", () => {
    const s = mem();
    writeLanesView(s, true);
    expect(s.m.get(LANES_KEY)).toBe("1");
    expect(readLanesView(s)).toBe(true);
    writeLanesView(s, false);
    expect(readLanesView(s)).toBe(false);
  });
  test("no storage or a throwing one: main track, no crash", () => {
    expect(readLanesView(null)).toBe(false);
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readLanesView(bad)).toBe(false);
    expect(() => writeLanesView(bad, true)).not.toThrow();
  });
});
