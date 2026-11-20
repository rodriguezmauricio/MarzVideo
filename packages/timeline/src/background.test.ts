import { describe, expect, it } from "vitest";
import { backgroundEdits, parseProject } from "@marz/format";
import { setBackground } from "./background";

const base = parseProject({
  version: 1, id: "p", name: "P", createdAt: "2026-11-19T00:00:00Z", durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 30 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 30 },
});

describe("setBackground", () => {
  it("turns a background on with the default options", () => {
    const p = setBackground({ style: "glow" })(base);
    expect(backgroundEdits(p)).toEqual({ style: "glow", padding: "M", corners: "round", shadow: true, gradient: "ink-accent", image: null });
    expect(p.edits.background).toEqual({ style: "glow" });
  });

  it("returns the same project when nothing changes", () => {
    expect(setBackground({ style: "off" })(base)).toBe(base);
    const p = setBackground({ style: "ink" })(base);
    expect(setBackground({ style: "ink", shadow: true })(p)).toBe(p);
  });

  it("keeps fields this build cannot read", () => {
    const p = { ...base, edits: { ...base.edits, background: { style: "ink", blur: 3 } } };
    expect(setBackground({ padding: "L" })(p).edits.background).toEqual({ style: "ink", blur: 3, padding: "L" });
  });
});

describe("setBackground with an image", () => {
  it("sets the image and the style in one step, and a second pick of the same file changes nothing", () => {
    const p = setBackground({ style: "image", image: "assets/background-1a2b3c4d.jpg" })(base);
    expect(p.edits.background).toEqual({ style: "image", image: "assets/background-1a2b3c4d.jpg" });
    expect(setBackground({ image: "assets/background-1a2b3c4d.jpg" })(p)).toBe(p);
  });

  it("picks a gradient pair", () => {
    const p = setBackground({ style: "gradient", gradient: "ink-paper" })(base);
    expect(backgroundEdits(p)).toMatchObject({ style: "gradient", gradient: "ink-paper" });
  });
});
