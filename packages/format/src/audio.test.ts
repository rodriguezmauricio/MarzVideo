import { describe, expect, test } from "vitest";
import { audioEdits, DEFAULT_AUDIO_EDITS, parseProject, serializeProject } from "./index";

const base = (edits: Record<string, unknown> = {}) => ({
  version: 1,
  id: "a",
  name: "Audio",
  createdAt: "2026-11-19T00:00:00Z",
  durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 60 },
  tracks: {
    screen: { file: "screen.mp4", offsetUs: 0 },
    mic: { file: "mic.wav", offsetUs: 0, volume: 1, muted: false },
    system: { file: "system.wav", offsetUs: 0, volume: 0.5, muted: true },
  },
  output: { width: 1920, height: 1080, fps: 60 },
  edits,
});

describe("edits.audio", () => {
  test("missing means noise removal and even loudness on, no fades", () => {
    const a = audioEdits(parseProject(base()));
    expect(a).toEqual(DEFAULT_AUDIO_EDITS);
    expect(a.denoise).toBe(true);
    expect(a.normalize).toBe(true);
    expect(a.mic).toEqual({ fadeInUs: 0, fadeOutUs: 0 });
    expect(a.system).toEqual({ fadeInUs: 0, fadeOutUs: 0 });
  });

  test("reads stored values and fills missing keys with defaults", () => {
    const p = parseProject(base({ audio: { denoise: false, mic: { fadeInUs: 500_000 } } }));
    const a = audioEdits(p);
    expect(a.denoise).toBe(false);
    expect(a.normalize).toBe(true);
    expect(a.mic).toEqual({ fadeInUs: 500_000, fadeOutUs: 0 });
    expect(a.system).toEqual({ fadeInUs: 0, fadeOutUs: 0 });
  });

  test("a broken value reads as the default instead of failing the project", () => {
    const p = parseProject(base({ audio: { denoise: "yes", mic: { fadeInUs: -5 }, system: 3 } }));
    const a = audioEdits(p);
    expect(a.denoise).toBe(true);
    expect(a.mic.fadeInUs).toBe(0);
    expect(a.system).toEqual({ fadeInUs: 0, fadeOutUs: 0 });
  });

  test("round trip keeps the block and unknown keys in it", () => {
    const e = base({ audio: { denoise: false, normalize: true, later: { x: 1 }, mic: { fadeInUs: 1, fadeOutUs: 2, curve: "log" } } });
    const out = JSON.parse(serializeProject(parseProject(e)));
    expect(out.edits.audio).toEqual(e.edits.audio);
  });

  test("track volume and mute stay on the tracks", () => {
    const p = parseProject(base());
    expect(p.tracks.system?.volume).toBe(0.5);
    expect(p.tracks.system?.muted).toBe(true);
  });
});
