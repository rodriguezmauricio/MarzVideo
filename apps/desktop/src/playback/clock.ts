import type { Segment } from "@marz/timeline";

/** Where playback should be for source time `srcUs`: itself, the start of the next kept segment, or null at the end. */
export function nextPlaybackTime(segs: Segment[], srcUs: number): number | null {
  for (const s of segs) {
    if (srcUs < s.srcStartUs) return s.srcStartUs;
    if (srcUs < s.srcEndUs) return srcUs;
  }
  return null;
}
