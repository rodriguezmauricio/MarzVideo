import { audioEdits, type AudioEdits, type AudioTrackKey, type Project, type TrackFade } from "@marz/format";
import type { Command } from "./commands";

const MAX_VOLUME = 2;

/** Set a track's volume (gain, 1 = 100%), clamped to 0..2 and rounded to whole percent. */
export const setTrackVolume =
  (track: AudioTrackKey, volume: number): Command =>
  (p) => {
    const t = p.tracks[track];
    if (!t) return p;
    const v = Math.round(Math.min(MAX_VOLUME, Math.max(0, volume)) * 100) / 100;
    return t.volume === v ? p : { ...p, tracks: { ...p.tracks, [track]: { ...t, volume: v } } };
  };

export const setTrackMuted =
  (track: AudioTrackKey, muted: boolean): Command =>
  (p) => {
    const t = p.tracks[track];
    if (!t || t.muted === muted) return p;
    return { ...p, tracks: { ...p.tracks, [track]: { ...t, muted } } };
  };

/** Writes the whole `edits.audio` (defaults filled in) over what is stored, keeping unknown keys. */
const writeAudio = (p: Project, next: AudioEdits): Project => {
  const stored = ((p.edits as Record<string, unknown>).audio ?? {}) as Record<string, unknown>;
  const merged = {
    ...stored,
    ...next,
    mic: { ...(stored.mic as object), ...next.mic },
    system: { ...(stored.system as object), ...next.system },
  };
  return { ...p, edits: { ...p.edits, audio: merged } };
};

export const setTrackFade =
  (track: AudioTrackKey, patch: Partial<TrackFade>): Command =>
  (p) => {
    const cur = audioEdits(p);
    const f = { ...cur[track], ...patch };
    f.fadeInUs = Math.max(0, Math.round(f.fadeInUs));
    f.fadeOutUs = Math.max(0, Math.round(f.fadeOutUs));
    if (f.fadeInUs === cur[track].fadeInUs && f.fadeOutUs === cur[track].fadeOutUs) return p;
    return writeAudio(p, { ...cur, [track]: f });
  };

export const setAudioOption =
  (key: "denoise" | "normalize", on: boolean): Command =>
  (p) => {
    const cur = audioEdits(p);
    return cur[key] === on ? p : writeAudio(p, { ...cur, [key]: on });
  };

/** Gain of a track at output time `tOutUs`: volume x linear fade in from 0 and fade out to the end
 * (`durOutUs`), as FFmpeg `afade` does at export. Overlapping fades take the lower value. */
export function trackGain(volume: number, muted: boolean, fade: TrackFade, tOutUs: number, durOutUs: number): number {
  if (muted) return 0;
  let env = 1;
  if (fade.fadeInUs > 0) env = Math.min(env, Math.max(0, tOutUs) / fade.fadeInUs);
  if (fade.fadeOutUs > 0) env = Math.min(env, Math.max(0, durOutUs - tOutUs) / fade.fadeOutUs);
  return volume * Math.max(0, Math.min(1, env));
}
