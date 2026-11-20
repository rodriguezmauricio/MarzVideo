import { describe, expect, it } from "vitest";
import { keyItems, keysLook, parseProject, type MarzEvent } from "@marz/format";
import { importLiveKeys, KEY_HOLD_US, removeKeyItem, setKeys, updateKeyItem } from "./keys";

const base = parseProject({
  version: 1,
  id: "p",
  name: "P",
  createdAt: "2026-11-19T00:00:00Z",
  durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 30 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 30 },
});
const key = (tUs: number, ...keys: string[]): MarzEvent => ({ tUs, type: "key", keys });

describe("importLiveKeys", () => {
  it("does nothing without key lines", () => {
    expect(importLiveKeys([{ tUs: 0, type: "pause" }])(base)).toBe(base);
  });

  it("holds each press, counts repeats, ends a block at the next combo, clamps to the take", () => {
    const p = importLiveKeys([
      key(1_000_000, "Ctrl", "S"),
      key(1_500_000, "Ctrl", "S"),
      key(2_000_000, "Ctrl", "S"),
      key(3_000_000, "Enter"),
      key(9_500_000, "Esc"),
      key(12_000_000, "Tab"),
    ])(base);
    expect(keyItems(p)).toEqual([
      { id: "key-1", startUs: 1_000_000, endUs: 3_000_000, keys: ["Ctrl", "S"], count: 3, hidden: false },
      { id: "key-2", startUs: 3_000_000, endUs: 3_000_000 + KEY_HOLD_US, keys: ["Enter"], count: 1, hidden: false },
      { id: "key-3", startUs: 9_500_000, endUs: 10_000_000, keys: ["Esc"], count: 1, hidden: false },
    ]);
    // Once only.
    const again = { ...p, edits: { ...p.edits, keys: { ...(p.edits as unknown as { keys: object }).keys, items: [] } } };
    expect(importLiveKeys([key(0, "Esc")])(again)).toBe(again);
  });

  it("drops a block cut shorter than the minimum", () => {
    const p = importLiveKeys([key(1_000_000, "Ctrl", "C"), key(1_050_000, "Ctrl", "V")])(base);
    expect(keyItems(p).map((k) => k.keys.join("+"))).toEqual(["Ctrl+V"]);
  });
});

describe("key block commands", () => {
  const p = importLiveKeys([key(1_000_000, "Ctrl", "S"), key(3_000_000, "Enter")])(base);

  it("moves and trims between neighbours", () => {
    const moved = updateKeyItem("key-1", { startUs: 2_000_000, endUs: 3_500_000 })(p);
    expect(keyItems(moved)[0]).toMatchObject({ startUs: 1_500_000, endUs: 3_000_000 });
    const trimmed = updateKeyItem("key-1", { endUs: 9_000_000 })(p);
    expect(keyItems(trimmed)[0]!.endUs).toBe(3_000_000);
    const tiny = updateKeyItem("key-2", { endUs: 3_000_001 })(p);
    expect(keyItems(tiny)[1]!.endUs).toBe(3_100_000);
  });

  it("hides one block, removes one, and leaves p alone on no change", () => {
    expect(keyItems(updateKeyItem("key-2", { hidden: true })(p))[1]!.hidden).toBe(true);
    expect(keyItems(removeKeyItem("key-1")(p)).map((k) => k.id)).toEqual(["key-2"]);
    expect(updateKeyItem("key-1", { hidden: false })(p)).toBe(p);
    expect(removeKeyItem("nope")(p)).toBe(p);
  });

  it("sets the look and keeps the blocks", () => {
    const q = setKeys({ position: "topRight", style: "paper", show: false })(p);
    expect(keysLook(q)).toEqual({ show: false, position: "topRight", size: "M", style: "paper" });
    expect(keyItems(q)).toEqual(keyItems(p));
    expect(setKeys({ size: "M" })(p)).toBe(p);
  });
});
