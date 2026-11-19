// The Edits track of the main track view (DESIGN-SYSTEM.md "Timeline", two views): every editable
// block on one track, stacked in rows where they overlap in time.

/** Height of the Edits track, px. */
export const MAIN_TRACK = 104;
const PAD = 6;
const GAP = 4;
const MAX_ROW = 34;

type Item = { id: string; startUs: number; endUs: number };

/** Each item's row: the first row whose last block ended by its start, earlier starts first. */
export function packRows(items: Item[]): { row: Map<string, number>; rows: number } {
  const sorted = [...items].sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs || a.id.localeCompare(b.id));
  const ends: number[] = [];
  const row = new Map<string, number>();
  for (const it of sorted) {
    let r = ends.findIndex((e) => e <= it.startUs);
    if (r < 0) r = ends.length;
    ends[r] = it.endUs;
    row.set(it.id, r);
  }
  return { row, rows: Math.max(1, ends.length) };
}

/** Top and height (px) of row `r` of `rows` inside the Edits track. */
export function rowGeometry(r: number, rows: number): { top: number; height: number } {
  const h = Math.min(MAX_ROW, (MAIN_TRACK - 2 * PAD - GAP * (rows - 1)) / rows);
  return { top: PAD + r * (h + GAP), height: h };
}
