import type { CutReason, Word } from "@marz/format";
import { isPureFiller } from "./fillers";
import { maxLevel, meanLevel, quietRanges, type Levels } from "./levels";

/** One cut the rules (or the AI) want, before it becomes a project `Cut`. For a silence the word
 * ids are the words on each side ("^" before the first word, "$" after the last); for a filler or
 * a mistake they are the first and last word cut. */
export type CutSpan = { startUs: number; endUs: number; reason: CutReason; fromWordId: string; toWordId: string };

export type RuleOptions = { silenceGapUs: number; paceUs: number; durationUs: number };

export const DEFAULT_SILENCE_GAP_US = 800_000;
/** Cuts shorter than this are not worth a cut. */
const MIN_CUT_US = 60_000;
/** Look this far around a word when checking it has voice under it (word timings drift). */
const WORD_SLACK_US = 100_000;

/** Words Whisper wrote over silent audio (hallucinations like "Obrigado." on a quiet stretch) are
 * dropped. With no levels, every word stays. */
export function cleanWords(words: Word[], levels: Levels | null): Word[] {
  if (!levels) return words;
  return words.filter((w) => maxLevel(levels, w.startUs - WORD_SLACK_US, w.endUs + WORD_SLACK_US) >= levels.floor);
}

const gapIsQuiet = (levels: Levels | null, a: number, b: number) => !levels || meanLevel(levels, a, b) < levels.floor;

/** Silence and pure filler cuts, merged where they touch, clamped to the take, in time order. */
export function ruleCuts(words: Word[], levels: Levels | null, opts: RuleOptions): CutSpan[] {
  const { silenceGapUs, paceUs, durationUs } = opts;
  if (words.length === 0) return [];
  const spans: CutSpan[] = [];

  // Silences between words, and before the first and after the last word.
  const edges = [
    { startUs: 0, endUs: words[0]!.startUs, from: "^", to: words[0]!.id, lead: true, tail: false },
    ...words.slice(1).map((w, i) => ({ startUs: words[i]!.endUs, endUs: w.startUs, from: words[i]!.id, to: w.id, lead: false, tail: false })),
    { startUs: words[words.length - 1]!.endUs, endUs: durationUs, from: words[words.length - 1]!.id, to: "$", lead: false, tail: true },
  ];
  for (const g of edges) {
    if (g.endUs - g.startUs < silenceGapUs) continue;
    const s = g.lead ? 0 : g.startUs + paceUs;
    const e = g.tail ? durationUs : g.endUs - paceUs;
    if (!gapIsQuiet(levels, s, e)) continue;
    spans.push({ startUs: s, endUs: e, reason: "silence", fromWordId: g.from, toWordId: g.to });
  }

  // Pure fillers: the word and the gaps around it to the nearest real words, minus the pace.
  const filler = words.map((w, i) =>
    isPureFiller(w, i > 0 ? w.startUs - words[i - 1]!.endUs : Infinity, i < words.length - 1 ? words[i + 1]!.startUs - w.endUs : Infinity),
  );
  for (let i = 0; i < words.length; i++) {
    if (!filler[i]) continue;
    let p = i - 1;
    while (p >= 0 && filler[p]) p--;
    let n = i + 1;
    while (n < words.length && filler[n]) n++;
    const w = words[i]!;
    const prevEnd = p >= 0 ? words[p]!.endUs : 0;
    const nextStart = n < words.length ? words[n]!.startUs : durationUs;
    spans.push({
      startUs: Math.min(w.startUs, p >= 0 ? prevEnd + paceUs : prevEnd),
      endUs: Math.max(w.endUs, n < words.length ? nextStart - paceUs : nextStart),
      reason: "filler",
      fromWordId: w.id,
      toWordId: w.id,
    });
  }

  return mergeSpans(spans, durationUs);
}

/** Sorts, clamps and merges spans that overlap or touch. A merged span is a filler when any part
 * is (it then covers at least one word); its word ids are the outermost ones. */
export function mergeSpans(spans: CutSpan[], durationUs: number): CutSpan[] {
  const sorted = spans
    .map((s) => ({ ...s, startUs: Math.max(0, s.startUs), endUs: Math.min(durationUs, s.endUs) }))
    .filter((s) => s.endUs > s.startUs)
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  const out: CutSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startUs <= last.endUs) {
      if (s.endUs > last.endUs) {
        last.endUs = s.endUs;
        last.toWordId = s.toWordId;
      }
      if (rank(s.reason) > rank(last.reason)) last.reason = s.reason;
      if (s.reason !== "silence" && last.reason === s.reason && last.fromWordId === "^") last.fromWordId = s.fromWordId;
    } else out.push({ ...s });
  }
  return out.filter((s) => s.endUs - s.startUs >= MIN_CUT_US);
}

const rank = (r: CutReason) => (r === "mistake" ? 2 : r === "filler" ? 1 : 0);

/** Silence cuts from the mic level alone, when there is no transcript (transcription failed). The
 * word ids are the range in ms ("t1200"), so a rejected one stays rejected while the levels match. */
export function levelCuts(levels: Levels, opts: RuleOptions): CutSpan[] {
  const spans = quietRanges(levels, opts.silenceGapUs).map((q): CutSpan => {
    const lead = q.startUs <= levels.offsetUs;
    const tail = q.endUs >= levels.offsetUs + levels.rms.length * levels.stepUs;
    return {
      startUs: lead ? 0 : q.startUs + opts.paceUs,
      endUs: tail ? opts.durationUs : q.endUs - opts.paceUs,
      reason: "silence",
      fromWordId: `t${Math.round(q.startUs / 1000)}`,
      toWordId: `t${Math.round(q.endUs / 1000)}`,
    };
  });
  return mergeSpans(spans, opts.durationUs);
}
