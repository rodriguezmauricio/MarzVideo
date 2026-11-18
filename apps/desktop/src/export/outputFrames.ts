import { outputDurationUs, outputToSource, type Segment } from "@marz/timeline";

/** Output frame k sits at k / fps on the output timeline. Its output time in whole microseconds. */
export function outputFrameUs(k: number, fps: number): number {
  return Math.round((k * 1e6) / fps);
}

/** Number of output frames: every k with k / fps < output duration. */
export function outputFrameCount(segs: Segment[], fps: number): number {
  return Math.ceil((outputDurationUs(segs) * fps) / 1e6);
}

/** Source time (us) of each output frame, in order, skipping everything that is cut. */
export function* outputFrameTimes(segs: Segment[], fps: number): Iterable<number> {
  const n = outputFrameCount(segs, fps);
  for (let k = 0; k < n; k++) yield outputToSource(segs, outputFrameUs(k, fps));
}

/** Why there is nothing to export, or null when there is. */
export function refuseEmpty(segs: Segment[]): string | null {
  return outputDurationUs(segs) > 0 ? null : "Nothing left to export. Every part is cut.";
}
