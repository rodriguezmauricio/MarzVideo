import { describe, expect, test } from "vitest";
import { clickSettings, cursorKind, cursorLiveImported, cursorSections, cursorSize } from "./cursor";
import { parseEvents } from "./events";
import { parseProject, serializeProject } from "./project";

const base = (edits: object = {}, source: object = {}) => ({
  version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
  source: { width: 1920, height: 1080, fps: 60, ...source },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 60 },
  edits: { zooms: [], cuts: [], ...edits },
});

describe("cursor fields in project.json", () => {
  test("old projects: layer cursor, size 1, no sections, click effects off with ripple", () => {
    const p = parseProject(base({ cursor: { hidden: false }, clicks: { effect: "none" } }));
    expect(cursorKind(p)).toBe("layer");
    expect(cursorSize(p)).toBe(1);
    expect(cursorSections(p)).toEqual([]);
    expect(clickSettings(p)).toEqual({ on: false, style: "ripple", color: "accent", size: "M" });
  });

  test("reads baked, size, sections and click settings", () => {
    const p = parseProject(
      base(
        {
          cursor: { hidden: true, size: 1.5, sections: [
            { id: "b", startUs: 5_000_000, endUs: 6_000_000, hide: false, clicks: true },
            { id: "a", startUs: 1_000_000, endUs: 2_000_000, hide: true, clicks: false },
          ] },
          clicks: { effect: "ring", style: "ring", color: "paper", size: "L" },
        },
        { cursor: "baked" },
      ),
    );
    expect(cursorKind(p)).toBe("baked");
    expect(cursorSize(p)).toBe(1.5);
    expect(cursorSections(p).map((s) => s.id)).toEqual(["a", "b"]);
    expect(clickSettings(p)).toEqual({ on: true, style: "ring", color: "paper", size: "L" });
  });

  test("effects off keep the remembered style", () => {
    const p = parseProject(base({ clicks: { effect: "none", style: "pulse" } }));
    expect(clickSettings(p)).toEqual({ on: false, style: "pulse", color: "accent", size: "M" });
  });

  test("unknown values read as defaults and are written back unchanged", () => {
    const raw = base(
      { cursor: { hidden: false, size: 3, sections: [{ id: "x", startUs: 0, endUs: 1_000_000, hide: "maybe" }] }, clicks: { effect: "sparkle", color: "blue", size: "XL" } },
      { cursor: "projected" },
    );
    const p = parseProject(raw);
    expect(cursorKind(p)).toBe("layer");
    expect(cursorSize(p)).toBe(1);
    expect(cursorSections(p)).toEqual([]);
    expect(clickSettings(p)).toEqual({ on: false, style: "ripple", color: "accent", size: "M" });
    const out = JSON.parse(serializeProject(p));
    expect(out.edits.cursor.size).toBe(3);
    expect(out.edits.cursor.sections[0].hide).toBe("maybe");
    expect(out.edits.clicks.effect).toBe("sparkle");
    expect(out.source.cursor).toBe("projected");
  });
});

describe("cursorShape events", () => {
  const head = '{"type":"header","version":1,"source":{"width":1920,"height":1080,"fps":60},"startedAt":"2026-11-19T00:00:00Z"}';
  test("parses shape and px; unknown shapes read as other; px defaults to 32", () => {
    const { events } = parseEvents(
      [
        head,
        '{"tUs":0,"type":"cursorShape","shape":"hand","px":48}',
        '{"tUs":10,"type":"cursorShape","shape":"zigzag","px":32}',
        '{"tUs":20,"type":"cursorShape","shape":"ibeam"}',
      ].join("\n"),
    );
    expect(events).toEqual([
      { tUs: 0, type: "cursorShape", shape: "hand", px: 48 },
      { tUs: 10, type: "cursorShape", shape: "other", px: 32 },
      { tUs: 20, type: "cursorShape", shape: "ibeam", px: 32 },
    ]);
  });
});

describe("cursorHidden events (live hide cursor)", () => {
  const head = '{"type":"header","version":1,"source":{"width":1920,"height":1080,"fps":60},"startedAt":"2026-11-19T00:00:00Z"}';
  test("parses on and off lines; odd ones are skipped", () => {
    const { events } = parseEvents(
      [
        head,
        '{"tUs":1000000,"type":"cursorHidden","hidden":true}',
        '{"tUs":2000000,"type":"cursorHidden","hidden":"yes"}',
        '{"tUs":3000000,"type":"cursorHidden","hidden":false}',
      ].join("\n"),
    );
    expect(events).toEqual([
      { tUs: 1_000_000, type: "cursorHidden", hidden: true },
      { tUs: 3_000_000, type: "cursorHidden", hidden: false },
    ]);
  });
  test("liveImported is read and kept on save", () => {
    expect(cursorLiveImported(parseProject(base({ cursor: { hidden: false } })))).toBe(false);
    const p = parseProject(base({ cursor: { hidden: false, liveImported: true } }));
    expect(cursorLiveImported(p)).toBe(true);
    expect(cursorLiveImported(parseProject(JSON.parse(serializeProject(p))))).toBe(true);
  });
});
