import { describe, expect, test } from "vitest";
import { FormatError, parseProject, serializeProject } from "./project";

const example = () => ({
  version: 1,
  id: "6f1c2a9e-0000-4000-8000-000000000001",
  name: "My Recording",
  createdAt: "2026-11-15T19:00:00Z",
  durationUs: 63500000,
  source: { width: 2560, height: 1440, fps: 60 },
  tracks: {
    screen: { file: "screen.mp4", offsetUs: 0 },
    mic: { file: "mic.wav", offsetUs: 12400, volume: 1, muted: false },
  },
  output: { width: 1920, height: 1080, fps: 60 },
  zoomPresets: [{ id: "p1", name: "Editor", rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
  edits: {
    zooms: [
      {
        id: "z1",
        startUs: 4100000,
        endUs: 8200000,
        rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        easeInUs: 400000,
        easeOutUs: 400000,
        easing: "easeInOutCubic",
        origin: "live",
      },
    ],
    cuts: [{ id: "c1", startUs: 20000000, endUs: 23500000 }],
    cursor: { hidden: false },
    clicks: { effect: "none" },
  },
});

describe("parseProject", () => {
  test("parses the design-doc example and round-trips", () => {
    const p = parseProject(example());
    const again = parseProject(JSON.parse(serializeProject(p)));
    expect(again).toEqual(p);
    expect(p.edits.zooms[0]?.origin).toBe("live");
  });

  test("preserves unknown fields", () => {
    const input = { ...example(), futureThing: { a: 1 } } as any;
    input.edits.layout = [];
    const out = JSON.parse(serializeProject(parseProject(input)));
    expect(out.futureThing).toEqual({ a: 1 });
    expect(out.edits.layout).toEqual([]);
  });

  test("rejects wrong version", () => {
    expect(() => parseProject({ ...example(), version: 2 })).toThrowError(/version/);
    expect(() => parseProject({ ...example(), version: 2 })).toThrowError(FormatError);
  });

  test("rejects missing screen track", () => {
    const input = example() as any;
    delete input.tracks.screen;
    expect(() => parseProject(input)).toThrowError(/tracks\.screen/);
  });

  test("accepts a project without mic", () => {
    const input = example() as any;
    delete input.tracks.mic;
    expect(parseProject(input).tracks.mic).toBeUndefined();
  });

  test("defaults zooms and cuts to empty arrays", () => {
    const input = example() as any;
    input.edits = {};
    const p = parseProject(input);
    expect(p.edits.zooms).toEqual([]);
    expect(p.edits.cuts).toEqual([]);
  });

  test("serialize ends with a newline and uses 2-space indent", () => {
    const s = serializeProject(parseProject(example()));
    expect(s.endsWith("}\n")).toBe(true);
    expect(s).toContain('\n  "version": 1');
  });
});
