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
