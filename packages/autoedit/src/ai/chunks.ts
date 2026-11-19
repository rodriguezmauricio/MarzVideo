import type { EditPassInput } from "./types";

const MIN = 60_000_000;
/** Takes up to this long go to the AI in one request. */
export const SINGLE_CHUNK_MAX_US = 30 * MIN;
export const CHUNK_US = 20 * MIN;
export const CHUNK_OVERLAP_US = 30_000_000;

/** Splits a long take into 20 minute windows with 30 s overlap (one window up to 30 minutes). */
export function chunkInput(input: EditPassInput, durationUs: number): EditPassInput[] {
  if (durationUs <= SINGLE_CHUNK_MAX_US) return [input];
  const out: EditPassInput[] = [];
  for (let a = 0; a < durationUs; a += CHUNK_US - CHUNK_OVERLAP_US) {
    const b = Math.min(durationUs, a + CHUNK_US);
    const inside = (s: number, e: number) => s < b && e > a;
    out.push({
      words: input.words.filter((w) => w.startUs >= a && w.startUs < b),
      sections: input.sections.filter((s) => inside(s.startUs, s.endUs)),
      ruleCuts: input.ruleCuts.filter((c) => inside(c.startUs, c.endUs)),
      candidates: input.candidates.filter((c) => inside(c.startUs, c.endUs)),
    });
    if (b >= durationUs) break;
  }
  return out;
}
