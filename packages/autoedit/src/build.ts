import { aiEdits, type Cut, type MarzEvent, type Project, type RejectedAiEdit, type Word, type Zoom } from "@marz/format";
import { suggestZooms } from "@marz/timeline";
import type { AiResult, ZoomCandidate } from "./ai/types";
import type { Levels } from "./levels";
import { DEFAULT_SILENCE_GAP_US, mergeSpans, ruleCuts, type CutSpan } from "./rules";

/** The M1 click clusters as zoom candidates, ids `k1..kN` by start time (stable for the same events). */
export function zoomCandidates(events: MarzEvent[], project: Project): ZoomCandidate[] {
  const aspect = project.output.width / project.output.height;
  return suggestZooms(events, project.source, aspect)
    .sort((a, b) => a.startUs - b.startUs)
    .map((z, i) => ({ id: `k${i + 1}`, startUs: z.startUs, endUs: z.endUs, rect: z.rect }));
}

export type BuildInput = {
  project: Project;
  words: Word[];
  levels: Levels | null;
  candidates: ZoomCandidate[];
  ai: AiResult | null;
  /** Spans to use instead of word rules (silences from levels when there is no transcript). */
  fallbackSpans?: CutSpan[];
};

const isRejected = (rejected: RejectedAiEdit[], s: CutSpan) =>
  rejected.some((r) => r.kind === "cut" && r.reason === s.reason && r.fromWordId === s.fromWordId && r.toWordId === s.toWordId);

/** A word range cut with the pace kept on both sides (like a filler): the words and the gaps to
 * the neighbouring words, minus the pace. */
function rangeSpan(words: Word[], fromIdx: number, toIdx: number, paceUs: number, durationUs: number, reason: CutSpan["reason"]): CutSpan {
  const a = words[fromIdx]!;
  const b = words[toIdx]!;
  const prev = words[fromIdx - 1];
  const next = words[toIdx + 1];
  return {
    startUs: Math.min(a.startUs, prev ? prev.endUs + paceUs : 0),
    endUs: Math.max(b.endUs, next ? next.startUs - paceUs : durationUs),
    reason,
    fromWordId: a.id,
    toWordId: b.id,
  };
}

/** Every AI edit for this project: rule cuts, the AI's mistakes and context fillers, and the zoom
 * candidates it picked. Respects `edits.ai.kinds`, `paceUs` and `rejected`. All `origin: "ai"`. */
export function buildAiEdits(input: BuildInput): { cuts: Cut[]; zooms: Zoom[] } {
  const { project, words, levels, candidates, ai } = input;
  const settings = aiEdits(project);
  const { kinds, paceUs, rejected } = settings;
  const durationUs = project.durationUs;
  const index = new Map(words.map((w, i) => [w.id, i]));

  const spans: CutSpan[] = (input.fallbackSpans ?? ruleCuts(words, levels, { silenceGapUs: DEFAULT_SILENCE_GAP_US, paceUs, durationUs })).filter(
    (s) => (s.reason === "silence" ? kinds.silences : kinds.fillers),
  );

  if (ai) {
    if (kinds.mistakes)
      for (const m of ai.mistakes) {
        const a = index.get(m.fromWordId);
        const b = index.get(m.toWordId);
        if (a !== undefined && b !== undefined && a <= b) spans.push(rangeSpan(words, a, b, paceUs, durationUs, "mistake"));
      }
    if (kinds.fillers)
      for (const id of ai.contextFillers) {
        const i = index.get(id);
        if (i !== undefined) spans.push(rangeSpan(words, i, i, paceUs, durationUs, "filler"));
      }
  }

  const cuts: Cut[] = mergeSpans(
    spans.filter((s) => !isRejected(rejected, s)),
    durationUs,
  )
    .filter((s) => !isRejected(rejected, s))
    .map((s) => ({
      id: `ai-${s.reason}-${s.fromWordId}-${s.toWordId}`,
      startUs: s.startUs,
      endUs: s.endUs,
      origin: "ai",
      reason: s.reason,
      fromWordId: s.fromWordId,
      toWordId: s.toWordId,
    }));

  const zooms: Zoom[] = [];
  if (ai && kinds.zooms) {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    for (const z of ai.zooms) {
      const c = byId.get(z.candidateId);
      const a = index.get(z.fromWordId);
      const b = index.get(z.toWordId);
      if (!c || a === undefined || b === undefined || a > b) continue;
      if (rejected.some((r) => r.kind === "zoom" && r.candidateId === c.id)) continue;
      if (zooms.some((x) => x.candidateId === c.id)) continue;
      const startUs = Math.max(0, words[a]!.startUs);
      const endUs = Math.min(durationUs, Math.max(words[b]!.endUs, startUs + MIN_ZOOM_US));
      zooms.push({
        id: `ai-zoom-${c.id}`,
        startUs,
        endUs,
        rect: c.rect,
        easeInUs: 400_000,
        easeOutUs: 400_000,
        easing: "easeInOutCubic",
        origin: "ai",
        candidateId: c.id,
      });
    }
  }
  return { cuts, zooms };
}

/** An AI zoom shorter than this would only flash in and out. */
const MIN_ZOOM_US = 1_200_000;
