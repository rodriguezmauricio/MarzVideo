import { describe, expect, test } from "vitest";
import { audioEdits, parseProject } from "@marz/format";
import { setAudioOption, setTrackFade, setTrackMuted, setTrackVolume, trackGain } from "./audio";
import { History } from "./history";

const project = () =>
  parseProject({
    version: 1,
    id: "a",
    name: "Audio",
    createdAt: "2026-11-19T00:00:00Z",
    durationUs: 10_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: {
      screen: { file: "screen.mp4", offsetUs: 0 },
      mic: { file: "mic.wav", offsetUs: 0, volume: 1, muted: false, gainDb: 3 },
      system: { file: "system.wav", offsetUs: 0, volume: 1, muted: false },
    },
    output: { width: 1920, height: 1080, fps: 60 },
    edits: { audio: { keepMe: 1 } },
  });

describe("audio commands", () => {
  test("volume and mute change one track and keep its other fields", () => {
    const p = setTrackMuted("system", true)(setTrackVolume("mic", 0.8)(project()));
    expect(p.tracks.mic?.volume).toBe(0.8);
    expect(p.tracks.mic?.gainDb).toBe(3);
    expect(p.tracks.system?.muted).toBe(true);
    expect(p.tracks.system?.volume).toBe(1);
  });

  test("volume is clamped to 0..2 and rounded to whole percent", () => {
    expect(setTrackVolume("mic", -1)(project()).tracks.mic?.volume).toBe(0);
    expect(setTrackVolume("mic", 0.333)(project()).tracks.mic?.volume).toBe(0.33);
    expect(setTrackVolume("mic", 9)(project()).tracks.mic?.volume).toBe(2);
  });

  test("no change returns the same project, so History skips it", () => {
    const p = project();
    expect(setTrackVolume("mic", 1)(p)).toBe(p);
    expect(setTrackMuted("mic", false)(p)).toBe(p);
    expect(setTrackFade("mic", { fadeInUs: 0 })(p)).toBe(p);
    expect(setAudioOption("denoise", true)(p)).toBe(p);
  });

  test("a missing track is left alone", () => {
    const p = project();
    const noSys = { ...p, tracks: { ...p.tracks, system: undefined } };
    expect(setTrackVolume("system", 0.5)(noSys)).toBe(noSys);
  });

  test("fades and options write edits.audio and keep unknown keys", () => {
    const p = setAudioOption("normalize", false)(setTrackFade("system", { fadeInUs: 1_000_000, fadeOutUs: 2_000_000 })(project()));
    const a = audioEdits(p);
    expect(a.system).toEqual({ fadeInUs: 1_000_000, fadeOutUs: 2_000_000 });
    expect(a.mic).toEqual({ fadeInUs: 0, fadeOutUs: 0 });
    expect(a.normalize).toBe(false);
    expect(a.denoise).toBe(true);
    expect((p.edits as Record<string, unknown>).audio).toMatchObject({ keepMe: 1 });
  });

  test("each change is one undo step", () => {
    const h = new History(project());
    h.apply(setTrackVolume("mic", 0.5));
    h.apply(setTrackFade("mic", { fadeInUs: 500_000, fadeOutUs: 500_000 }));
    expect(audioEdits(h.current).mic.fadeInUs).toBe(500_000);
    h.undo();
    expect(audioEdits(h.current).mic.fadeInUs).toBe(0);
    expect(h.current.tracks.mic?.volume).toBe(0.5);
    h.undo();
    expect(h.current.tracks.mic?.volume).toBe(1);
  });
});

describe("trackGain", () => {
  const fade = { fadeInUs: 1_000_000, fadeOutUs: 2_000_000 };
  test("volume times the fade envelope, linear", () => {
    expect(trackGain(0.8, false, fade, 0, 10_000_000)).toBe(0);
    expect(trackGain(0.8, false, fade, 500_000, 10_000_000)).toBeCloseTo(0.4);
    expect(trackGain(0.8, false, fade, 5_000_000, 10_000_000)).toBeCloseTo(0.8);
    expect(trackGain(0.8, false, fade, 9_000_000, 10_000_000)).toBeCloseTo(0.4);
    expect(trackGain(0.8, false, fade, 10_000_000, 10_000_000)).toBe(0);
  });
  test("muted is 0, no fades is the volume", () => {
    expect(trackGain(1, true, fade, 5_000_000, 10_000_000)).toBe(0);
    expect(trackGain(0.6, false, { fadeInUs: 0, fadeOutUs: 0 }, 0, 10_000_000)).toBe(0.6);
  });
  test("fades longer than the video overlap as the lower of the two", () => {
    const long = { fadeInUs: 4_000_000, fadeOutUs: 4_000_000 };
    expect(trackGain(1, false, long, 2_000_000, 4_000_000)).toBeCloseTo(0.5);
  });
});
