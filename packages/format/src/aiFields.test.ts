import { describe, expect, test } from "vitest";
import { aiEdits, DEFAULT_AI_EDITS, parseProject, serializeProject } from "./project";

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

const roundTrip = (e: unknown) => JSON.parse(serializeProject(parseProject(e)));

describe("M2 edit fields and tolerant readers", () => {
  test("reads an M1 project unchanged", () => {
    const e = example();
    expect(roundTrip(e)).toEqual(e);
  });

  test("unknown zoom origin reads as manual and saves the original", () => {
    const e = example() as any;
    e.edits.zooms[0].origin = "robot";
    const p = parseProject(e);
    expect(p.edits.zooms[0]?.origin).toBe("manual");
    expect(roundTrip(e).edits.zooms[0].origin).toBe("robot");
    expect(serializeProject(p)).not.toContain("__raw_");
  });

  test("unknown easing reads as easeInOutCubic and saves the original", () => {
    const e = example() as any;
    e.edits.zooms[0].easing = "bounce";
    expect(parseProject(e).edits.zooms[0]?.easing).toBe("easeInOutCubic");
    expect(roundTrip(e).edits.zooms[0].easing).toBe("bounce");
  });

  test("an edited tolerant field keeps the edited value", () => {
    const e = example() as any;
    e.edits.zooms[0].origin = "robot";
    const p = parseProject(e);
    p.edits.zooms[0]!.origin = "ai";
    expect(JSON.parse(serializeProject(p)).edits.zooms[0].origin).toBe("ai");
  });

  test("cut origin and reason round trip", () => {
    const e = example() as any;
    e.edits.cuts = [
      { id: "c1", startUs: 1, endUs: 2, origin: "ai", reason: "filler" },
      { id: "c2", startUs: 3, endUs: 4, origin: "alien", reason: "boredom" },
    ];
    const p = parseProject(e);
    expect(p.edits.cuts[0]).toMatchObject({ origin: "ai", reason: "filler" });
    expect(p.edits.cuts[1]?.origin).toBe("manual");
    expect(p.edits.cuts[1]?.reason).toBeUndefined();
    expect(roundTrip(e).edits.cuts).toEqual(e.edits.cuts);
  });

  test("ai zoom with candidate id round trips", () => {
    const e = example() as any;
    e.edits.zooms[0].origin = "ai";
    e.edits.zooms[0].candidateId = "k3";
    expect(parseProject(e).edits.zooms[0]).toMatchObject({ origin: "ai", candidateId: "k3" });
    expect(roundTrip(e)).toEqual(e);
  });

  test("captions and ai edits round trip", () => {
    const e = example() as any;
    e.edits.captions = { overrides: { w12: "Marz" }, hidden: ["w40"] };
    e.edits.ai = {
      paceUs: 200000,
      kinds: { silences: true, fillers: false, mistakes: true, zooms: true, captions: true },
      rejected: [
        { kind: "cut", reason: "silence", fromWordId: "w3", toWordId: "w4" },
        { kind: "zoom", candidateId: "k2" },
      ],
      lastRun: { at: "2026-11-19T10:00:00Z", provider: "claude-code", model: "sonnet", languages: ["pt", "en"] },
      lastResult: { mistakes: [], contextFillers: ["w9"], zooms: [] },
    };
    const p = parseProject(e);
    expect(aiEdits(p).paceUs).toBe(200000);
    expect(roundTrip(e)).toEqual(e);
  });

  test("unknown fields inside edits.ai are preserved", () => {
    const e = example() as any;
    e.edits.ai = { ...DEFAULT_AI_EDITS, future: { x: 1 }, rejected: [{ kind: "scene", id: "s1" }] };
    const out = roundTrip(e);
    expect(out.edits.ai.future).toEqual({ x: 1 });
    expect(out.edits.ai.rejected).toEqual([{ kind: "scene", id: "s1" }]);
  });

  test("missing edits.ai gives the defaults", () => {
    expect(aiEdits(parseProject(example()))).toEqual(DEFAULT_AI_EDITS);
  });
});
