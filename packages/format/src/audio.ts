import type { Project } from "./project";

/** Fade lengths of one audio track, in output time (from the start / to the end of the export). */
export type TrackFade = { fadeInUs: number; fadeOutUs: number };

/** `edits.audio` (optional, design `2026-11-19-audio-cleanup-design.md`). Volume and mute live on
 * `tracks.mic` / `tracks.system`. Unknown keys are kept on save (`edits` is passthrough). */
export type AudioEdits = {
  /** Remove noise from the mic (preview plays `cache/mic.clean.wav`, export reads it). */
  denoise: boolean;
  /** Bring the exported mix to about -14 LUFS. */
  normalize: boolean;
  mic: TrackFade;
  system: TrackFade;
};

export type AudioTrackKey = "mic" | "system";

export const DEFAULT_AUDIO_EDITS: AudioEdits = {
  denoise: true,
  normalize: true,
  mic: { fadeInUs: 0, fadeOutUs: 0 },
  system: { fadeInUs: 0, fadeOutUs: 0 },
};

/** Loudness target of the export, in LUFS. */
export const TARGET_LUFS = -14;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const us = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const fade = (v: unknown): TrackFade => {
  const o = obj(v);
  return { fadeInUs: us(o.fadeInUs), fadeOutUs: us(o.fadeOutUs) };
};

/** The audio settings in force: `edits.audio` with defaults for missing or broken values. A broken
 * value never makes the project unopenable. */
export function audioEdits(p: Project): AudioEdits {
  const a = obj((p.edits as Record<string, unknown>).audio);
  return {
    denoise: bool(a.denoise, DEFAULT_AUDIO_EDITS.denoise),
    normalize: bool(a.normalize, DEFAULT_AUDIO_EDITS.normalize),
    mic: fade(a.mic),
    system: fade(a.system),
  };
}
