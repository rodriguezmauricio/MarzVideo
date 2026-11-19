import type { Word } from "@marz/format";
import type { AiResult, EditPassInput } from "./types";

/** More than this share of the spoken words cut by the AI means the answer is wrong. */
const MAX_CUT_SHARE = 0.5;

export const BAD_RESULT = "AI result looked wrong. Mistakes and AI zooms were skipped.";

const str = (v: unknown): v is string => typeof v === "string";
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Checks the AI's answer against the words it was given: unknown ids, reversed and overlapping
 * ranges are dropped; an answer that cuts most of the take is refused whole. */
export function validateResult(raw: unknown, input: EditPassInput): AiResult | { refused: string } {
  if (!raw || typeof raw !== "object") return { refused: BAD_RESULT };
  const index = new Map(input.words.map((w, i) => [w.id, i]));
  const r = obj(raw);

  const mistakes: AiResult["mistakes"] = [];
  const taken: Array<[number, number]> = [];
  const ranges = arr(r.mistakes)
    .map(obj)
    .filter((m) => str(m.fromWordId) && str(m.toWordId))
    .map((m) => ({ m, a: index.get(m.fromWordId as string), b: index.get(m.toWordId as string) }))
    .filter((x): x is { m: Record<string, unknown>; a: number; b: number } => x.a !== undefined && x.b !== undefined && x.a <= x.b)
    .sort((x, y) => x.a - y.a);
  for (const { m, a, b } of ranges) {
    if (taken.some(([s, e]) => a <= e && s <= b)) continue;
    taken.push([a, b]);
    mistakes.push({ fromWordId: m.fromWordId as string, toWordId: m.toWordId as string, why: str(m.why) ? m.why.slice(0, 80) : "" });
  }

  const inMistake = (i: number) => taken.some(([s, e]) => i >= s && i <= e);
  const contextFillers = [...new Set(arr(r.contextFillers).filter(str))].filter((id) => {
    const i = index.get(id);
    return i !== undefined && !inMistake(i);
  });

  const candidateIds = new Set(input.candidates.map((c) => c.id));
  const zooms: AiResult["zooms"] = [];
  const zoomRanges: Array<[number, number]> = [];
  for (const z of arr(r.zooms).map(obj)) {
    if (!str(z.candidateId) || !candidateIds.has(z.candidateId) || !str(z.fromWordId) || !str(z.toWordId)) continue;
    const a = index.get(z.fromWordId);
    const b = index.get(z.toWordId);
    if (a === undefined || b === undefined || a > b) continue;
    if (zooms.some((x) => x.candidateId === z.candidateId) || zoomRanges.some(([s, e]) => a <= e && s <= b)) continue;
    zoomRanges.push([a, b]);
    zooms.push({ candidateId: z.candidateId, fromWordId: z.fromWordId, toWordId: z.toWordId });
  }

  const cutWords = taken.reduce((s, [a, b]) => s + b - a + 1, 0) + contextFillers.length;
  if (input.words.length > 0 && cutWords > input.words.length * MAX_CUT_SHARE) return { refused: BAD_RESULT };
  return { mistakes, contextFillers, zooms };
}

/** Word order for merging chunk answers. */
const orderOf = (words: Word[]) => new Map(words.map((w, i) => [w.id, i]));

/** Joins the answers for overlapping chunks: a mistake or zoom found in both halves of an overlap is
 * kept once (identical or overlapping word ranges). */
export function mergeResults(results: AiResult[], words: Word[]): AiResult {
  const at = orderOf(words);
  const pos = (id: string) => at.get(id) ?? -1;
  const out: AiResult = { mistakes: [], contextFillers: [], zooms: [] };
  for (const r of results) {
    for (const m of r.mistakes) {
      const a = pos(m.fromWordId);
      const b = pos(m.toWordId);
      if (out.mistakes.some((x) => pos(x.fromWordId) <= b && a <= pos(x.toWordId))) continue;
      out.mistakes.push(m);
    }
    for (const id of r.contextFillers) if (!out.contextFillers.includes(id)) out.contextFillers.push(id);
    for (const z of r.zooms) {
      const a = pos(z.fromWordId);
      const b = pos(z.toWordId);
      if (out.zooms.some((x) => x.candidateId === z.candidateId || (pos(x.fromWordId) <= b && a <= pos(x.toWordId)))) continue;
      out.zooms.push(z);
    }
  }
  out.mistakes.sort((x, y) => pos(x.fromWordId) - pos(y.fromWordId));
  return out;
}
