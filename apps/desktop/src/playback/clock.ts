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

/** Presentation time in screen.mp4 (us) for source time `srcUs`. Frame 0 of the screen track was captured at
 *  `offsetUs` on the source clock and is presented at `firstFrameUs` in the file (0 for recordings without
 *  B-frames; the reorder delay, e.g. 50,000, for older ones). Preview and export share it. */
export function mediaTimeUs(project: Project, srcUs: number, firstFrameUs: number): number {
  return srcUs - project.tracks.screen.offsetUs + firstFrameUs;
}

/** Source time (us) of presentation time `mediaUs` in screen.mp4: the inverse of `mediaTimeUs`. */
export function sourceTimeUs(project: Project, mediaUs: number, firstFrameUs: number): number {
  return mediaUs - firstFrameUs + project.tracks.screen.offsetUs;
}
