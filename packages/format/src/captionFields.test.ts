import { describe, expect, test } from "vitest";
import { captionEdits, captionStyleFor, DEFAULT_CAPTION_STYLES, parseProject, serializeProject } from "./project";

const base = (captions?: unknown) => ({
  version: 1,
  id: "p",
  name: "n",
  createdAt: "2026-11-19T00:00:00Z",
  durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 30 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 30 },
  edits: captions === undefined ? {} : { captions },
});
const roundTrip = (e: unknown) => JSON.parse(serializeProject(parseProject(e)));

describe("caption breaks and styles", () => {
  test("an M2 captions object reads with empty breaks and styles", () => {
    const p = parseProject(base({ overrides: { w1: "A" }, hidden: [] }));
    expect(captionEdits(p).breaks).toEqual({});
    expect(captionEdits(p).styles).toEqual({});
  });

  test("breaks keep split and join; unknown values are dropped from the type but kept on save", () => {
    const e = base({ overrides: {}, hidden: [], breaks: { w1: "split", w2: "join", w3: "wobble" } });
    const p = parseProject(e);
    expect(captionEdits(p).breaks).toEqual({ w1: "split", w2: "join" });
    expect(roundTrip(e).edits.captions.breaks).toEqual({ w1: "split", w2: "join", w3: "wobble" });
  });

  test("style defaults per preset match today's output", () => {
    const p = parseProject(base());
    expect(captionStyleFor(p, "youtube")).toEqual(DEFAULT_CAPTION_STYLES.youtube);
    expect(DEFAULT_CAPTION_STYLES.youtube).toEqual({ style: "inkBand", size: "M", position: "bottom", highlight: false });
    expect(DEFAULT_CAPTION_STYLES.vertical).toEqual({ style: "plain", size: "M", position: "bottom", highlight: true });
  });

  test("a stored style fills missing fields from the default", () => {
    const p = parseProject(base({ overrides: {}, hidden: [], styles: { vertical: { size: "L" } } }));
    expect(captionStyleFor(p, "vertical")).toEqual({ style: "plain", size: "L", position: "bottom", highlight: true });
    expect(captionStyleFor(p, "youtube")).toEqual(DEFAULT_CAPTION_STYLES.youtube);
  });

  test("unknown style values read as the default and come back on save", () => {
    const e = base({ overrides: {}, hidden: [], styles: { youtube: { style: "neon", size: "XL", position: "left", highlight: true } } });
    const p = parseProject(e);
    expect(captionStyleFor(p, "youtube")).toEqual({ style: "inkBand", size: "M", position: "bottom", highlight: true });
    expect(roundTrip(e).edits.captions.styles.youtube).toEqual({ style: "neon", size: "XL", position: "left", highlight: true });
  });

  test("an unknown preset key is kept on save", () => {
    const e = base({ overrides: {}, hidden: [], styles: { square: { style: "plain" } } });
    expect(roundTrip(e).edits.captions.styles.square).toEqual({ style: "plain" });
  });
});
