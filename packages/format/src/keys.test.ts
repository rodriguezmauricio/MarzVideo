import { describe, expect, it } from "vitest";
import { parseProject, serializeProject } from "./project";
import { parseEvents } from "./events";
import { DEFAULT_KEYS_LOOK, keyComboLabel, keyItems, keysImported, keysLook } from "./keys";

const base = {
  version: 1,
  id: "p",
  name: "P",
  createdAt: "2026-11-19T00:00:00Z",
  durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 30 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 30 },
};
const HEADER = '{"type":"header","version":1,"source":{"width":1920,"height":1080,"fps":30},"startedAt":"2026-11-19T00:00:00Z"}';

describe("key events", () => {
  it("parses key lines and drops empty ones", () => {
    const { events } = parseEvents(
      [HEADER, '{"tUs":1000,"type":"key","keys":["Ctrl","S"]}', '{"tUs":2000,"type":"key","keys":[]}', '{"tUs":3000,"type":"key","keys":["Ctrl","Weird"]}'].join("\n"),
    );
    expect(events).toEqual([
      { tUs: 1000, type: "key", keys: ["Ctrl", "S"] },
      { tUs: 3000, type: "key", keys: ["Ctrl", "Weird"] },
    ]);
  });
});

describe("edits.keys", () => {
  it("missing means the defaults and no blocks", () => {
    const p = parseProject(base);
    expect(keysLook(p)).toEqual(DEFAULT_KEYS_LOOK);
    expect(DEFAULT_KEYS_LOOK).toEqual({ show: true, position: "bottomLeft", size: "M", style: "ink" });
    expect(keyItems(p)).toEqual([]);
    expect(keysImported(p)).toBe(false);
  });

  it("reads a full block, sorted, and keeps unknown values on save", () => {
    const keys = {
      show: false,
      position: "topRight",
      size: "L",
      style: "accent",
      liveImported: true,
      extra: 1,
      items: [
        { id: "k2", startUs: 5_000_000, endUs: 6_000_000, keys: ["Enter"], count: 1, hidden: true },
        { id: "k1", startUs: 1_000_000, endUs: 2_500_000, keys: ["Ctrl", "S"], count: 3, hidden: false },
        { id: "bad", startUs: 3, endUs: 2, keys: ["Esc"] },
      ],
    };
    const p = parseProject({ ...base, edits: { keys } });
    expect(keysLook(p)).toEqual({ show: false, position: "topRight", size: "L", style: "accent" });
    expect(keysImported(p)).toBe(true);
    expect(keyItems(p).map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(keyItems(p)[1]!.hidden).toBe(true);
    expect(JSON.parse(serializeProject(p)).edits.keys).toEqual(keys);
  });

  it("unknown look values read as the defaults; a missing count reads as 1", () => {
    const p = parseProject({ ...base, edits: { keys: { show: "yes", position: "middle", size: 9, style: "lava", items: [{ id: "a", startUs: 0, endUs: 10, keys: ["Tab"] }] } } });
    expect(keysLook(p)).toEqual(DEFAULT_KEYS_LOOK);
    expect(keyItems(p)[0]!.count).toBe(1);
  });

  it("labels a combo", () => {
    expect(keyComboLabel({ keys: ["Ctrl", "Shift", "S"], count: 1 })).toBe("Ctrl+Shift+S");
    expect(keyComboLabel({ keys: ["Down"], count: 4 })).toBe("Down x4");
  });
});
