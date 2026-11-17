import type { Project } from "@marz/format";
import type { Segment } from "@marz/timeline";

/** Where playback should be for source time `srcUs`: itself, the start of the next kept segment, or null at the end. */
export function nextPlaybackTime(segs: Segment[], srcUs: number): number | null {
  for (const s of segs) {
    if (srcUs < s.srcStartUs) return s.srcStartUs;
    if (srcUs < s.srcEndUs) return srcUs;
  }
  return null;
}

/** True when playback has nothing left to play: the clock ran out of kept time, or the video element itself ended. */
export function playbackEnded(segs: Segment[], srcUs: number, videoEnded: boolean): boolean {
  return videoEnded || nextPlaybackTime(segs, srcUs) === null;
}

/** Where Play should start: the playhead if there is more to play, otherwise the first kept time; null if nothing is kept. */
export function startTimeForPlay(segs: Segment[], playheadUs: number): number | null {
  return nextPlaybackTime(segs, playheadUs) ?? segs[0]?.srcStartUs ?? null;
}

/** Time in screen.mp4 (us) for source time `srcUs`: the screen track started `offsetUs` after the source clock. Preview and export share it. */
export function mediaTimeUs(project: Project, srcUs: number): number {
  return srcUs - project.tracks.screen.offsetUs;
}
