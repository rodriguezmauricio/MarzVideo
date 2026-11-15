import type { Cut } from "@marz/format";

export type Segment = { srcStartUs: number; srcEndUs: number; outStartUs: number };

/** Kept (not cut) source ranges in order, with where each starts on the output timeline. */
export function keptSegments(durationUs: number, cuts: Cut[]): Segment[] {
  const ranges = cuts
    .map((c) => ({ s: Math.max(0, c.startUs), e: Math.min(durationUs, c.endUs) }))
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.s - b.s);

  const merged: { s: number; e: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else merged.push({ ...r });
  }

  const segs: Segment[] = [];
  let cursor = 0;
  let out = 0;
  const push = (s: number, e: number) => {
    if (e > s) {
      segs.push({ srcStartUs: s, srcEndUs: e, outStartUs: out });
      out += e - s;
    }
  };
  for (const m of merged) {
    push(cursor, m.s);
    cursor = m.e;
  }
  push(cursor, durationUs);
  return segs;
}

export function outputDurationUs(segs: Segment[]): number {
  const last = segs[segs.length - 1];
  return last ? last.outStartUs + (last.srcEndUs - last.srcStartUs) : 0;
}

/** Output time for a source time, or null when the source time is inside a cut. */
export function sourceToOutput(segs: Segment[], srcUs: number): number | null {
  for (const s of segs) {
    if (srcUs >= s.srcStartUs && srcUs < s.srcEndUs) return s.outStartUs + (srcUs - s.srcStartUs);
  }
  const last = segs[segs.length - 1];
  if (last && srcUs === last.srcEndUs) return outputDurationUs(segs);
  return null;
}

/** Source time for an output time. Clamps to the end; 0 when nothing is kept. */
export function outputToSource(segs: Segment[], outUs: number): number {
  for (const s of segs) {
    const len = s.srcEndUs - s.srcStartUs;
    if (outUs >= s.outStartUs && outUs < s.outStartUs + len) return s.srcStartUs + (outUs - s.outStartUs);
  }
  const last = segs[segs.length - 1];
  return last ? last.srcEndUs : 0;
}
