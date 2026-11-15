export const usToPx = (us: number, pxPerSec: number): number => (us / 1_000_000) * pxPerSec;

export const pxToUs = (px: number, pxPerSec: number): number => Math.round((px / pxPerSec) * 1_000_000);

/** Snap `us` to the nearest target within `thresholdUs`, otherwise return it unchanged. */
export function snapUs(us: number, targets: number[], thresholdUs: number): number {
  let best = us;
  let bestDist = thresholdUs + 1;
  for (const t of targets) {
    const d = Math.abs(t - us);
    if (d <= thresholdUs && d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/** Resize-handle width for a block `blockPx` wide: never so big that the middle cannot be grabbed. */
export const handleWidthPx = (blockPx: number): number => Math.max(1, Math.min(8, Math.floor(blockPx / 3)));

export const MAX_TIMELINE_ZOOM = 60;

/** Full timeline width for a viewport and a zoom factor (1 = whole recording fits). */
export const timelineWidthPx = (viewportPx: number, zoomFactor: number): number =>
  viewportPx * Math.min(MAX_TIMELINE_ZOOM, Math.max(1, zoomFactor));
