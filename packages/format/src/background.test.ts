import { describe, expect, it } from "vitest";
import { parseProject, serializeProject } from "./project";
import { backgroundEdits, DEFAULT_BACKGROUND_EDITS } from "./background";

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

describe("backgroundEdits", () => {
  it("missing means off with the default options", () => {
    expect(backgroundEdits(parseProject(base))).toEqual(DEFAULT_BACKGROUND_EDITS);
    expect(DEFAULT_BACKGROUND_EDITS).toEqual({ style: "off", padding: "M", corners: "round", shadow: true });
  });

  it("reads a full block", () => {
    const p = parseProject({ ...base, edits: { background: { style: "grid", padding: "L", corners: "square", shadow: false } } });
    expect(backgroundEdits(p)).toEqual({ style: "grid", padding: "L", corners: "square", shadow: false });
  });

  it("unknown or broken values read as the defaults, and are kept on save", () => {
    const background = { style: "lava", padding: 7, corners: "wavy", shadow: "yes", blur: 12 };
    const p = parseProject({ ...base, edits: { background } });
    expect(backgroundEdits(p)).toEqual(DEFAULT_BACKGROUND_EDITS);
    expect(JSON.parse(serializeProject(p)).edits.background).toEqual(background);
  });

  it("a non-object reads as off", () => {
    expect(backgroundEdits(parseProject({ ...base, edits: { background: "ink" } })).style).toBe("off");
  });
});
