const pad2 = (n: number) => String(n).padStart(2, "0");

/** "mm:ss" (whole seconds, floored). Used for the giant playhead number, ruler labels and the cut chip. */
export function mmss(us: number): string {
  const total = Math.floor(Math.max(0, us) / 1e6);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** "mm:ss.t" (tenths). Used for inspector values and the playhead line. */
export function mmsst(us: number): string {
  const tenths = Math.round(Math.max(0, us) / 1e5);
  const s = Math.floor(tenths / 10);
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}.${tenths % 10}`;
}

/** "12.0 s" */
export const seconds1 = (us: number): string => `${(us / 1e6).toFixed(1)} s`;

/** Parse "mm:ss.t", "ss.t" or "1.5 s" into microseconds; null if it is not a time. */
export function parseTimeUs(text: string): number | null {
  const t = text.trim().replace(/\s*s$/i, "");
  const m = /^(?:(\d+):)?(\d+(?:\.\d*)?)$/.exec(t);
  if (!m) return null;
  const v = (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]!);
  return Number.isFinite(v) ? Math.round(v * 1e6) : null;
}

/** "3 zooms", "1 cut" */
export const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The time typed in an inspector cell that shows `shown`, or null when there is nothing to commit:
 *  the text is unchanged (leaving the field must not round the value or add an undo step) or not a time. */
export function editedTimeUs(value: string, shown: string): number | null {
  return value.trim() === shown.trim() ? null : parseTimeUs(value);
}
