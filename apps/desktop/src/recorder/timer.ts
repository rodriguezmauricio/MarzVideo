// The recording timer on the bar: recording time (pauses excluded) from `recorder://state` ticks.

const pad = (n: number) => String(n).padStart(2, "0");

/** `mm:ss`, or `h:mm:ss` from one hour on. Negative or missing time reads 00:00. */
export function formatTimer(recUs: number): string {
  const total = Number.isFinite(recUs) && recUs > 0 ? Math.floor(recUs / 1_000_000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
