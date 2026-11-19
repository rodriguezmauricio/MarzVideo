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

/** Audio may drift this far from the video before it is put back. */
export const AUDIO_DRIFT_S = 0.04;

/** What an audio element should do this frame while the video plays. `wantS` is where the track should
 *  be (negative: the track has not started yet, its offset is still ahead). Before its start the track
 *  waits at 0, so it never runs ahead and then jumps back (the first stretch heard twice). */
export function audioStep(a: { wantS: number; currentS: number; paused: boolean; ended: boolean; videoPaused: boolean }): {
  play?: true;
  pause?: true;
  seekS?: number;
} {
  if (a.wantS < 0) return a.paused ? {} : { pause: true, seekS: 0 };
  if (a.ended) return {};
  const out: { play?: true; seekS?: number } = {};
  if (a.paused && !a.videoPaused) out.play = true;
  if (Math.abs(a.currentS - a.wantS) > AUDIO_DRIFT_S) out.seekS = a.wantS;
  return out;
}
