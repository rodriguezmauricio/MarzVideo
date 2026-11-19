import {
  AiProviderError,
  buildAiEdits,
  chunkInput,
  cleanWords,
  DEFAULT_SILENCE_GAP_US,
  EMPTY_RESULT,
  levelCuts,
  matchTopics,
  mergeResults,
  ruleCuts,
  validateResult,
  zoomCandidates,
  type AiProvider,
  type AiResult,
  type Levels,
} from "@marz/autoedit";
import { aiEdits, checklistItems, type MarzEvent, type Project, type Transcript, type Word } from "@marz/format";
import { applyAiPass, coverOpenItems, touchedRanges, type History } from "@marz/timeline";

export type AiStatus =
  | { step: "transcribing"; pct: number }
  | { step: "editing" }
  | { step: "done"; cuts: number; zooms: number; captions: boolean }
  | { step: "nothing" };

export type AiOutcome = { warnings: string[]; words: Word[]; applied: boolean };

/** Why transcription did not give a transcript. */
export class TranscribeFailure extends Error {
  constructor(
    readonly kind: "noWhisper" | "noModel" | "noMic" | "failed" | "cancelled" | "declined",
    message: string = kind,
  ) {
    super(message);
    this.name = "TranscribeFailure";
  }
}

export const SENTENCES = {
  noWhisper: "Whisper is missing. Install it or set MARZ_WHISPER. Only silences were cut.",
  transcribeFailed: "Transcription failed. Only silences were cut.",
  notInstalled: "Claude Code is not installed. Mistakes and AI zooms were skipped.",
  notSignedIn: "Claude Code is not signed in. Open it once and sign in.",
  usageLimit: "Claude usage limit reached. Rerun later.",
  badResult: "AI result looked wrong. Mistakes and AI zooms were skipped.",
  aiFailed: "The AI step failed. Mistakes and AI zooms were skipped.",
} as const;

export type AiPassDeps = {
  history: History;
  events: MarzEvent[];
  provider: AiProvider | null;
  /** Writes `transcript.json` when it is missing or stale (null: no transcription available). */
  transcribe: ((onPct: (pct: number) => void, signal: AbortSignal) => Promise<void>) | null;
  readTranscript: () => Promise<Transcript | null>;
  readLevels: () => Promise<Levels | null>;
  onStatus: (s: AiStatus) => void;
  signal: AbortSignal;
  now?: () => Date;
};

function providerSentence(e: unknown): string {
  if (e instanceof AiProviderError) {
    if (e.kind === "notInstalled") return SENTENCES.notInstalled;
    if (e.kind === "notSignedIn") return SENTENCES.notSignedIn;
    if (e.kind === "usageLimit") return SENTENCES.usageLimit;
    if (e.kind === "badResult") return SENTENCES.badResult;
  }
  return SENTENCES.aiFailed;
}

const aborted = (signal: AbortSignal) => signal.aborted;

/** The AI pass: transcribe (if needed), rules, the AI provider, then one `applyAiPass` step on the
 * history. Edits made during the run win. A closed project (abort) writes nothing. Failures of one
 * stage become one warning sentence each and the rest still applies. */
export async function runAiPass(deps: AiPassDeps): Promise<AiOutcome> {
  const { history, events, provider, signal, onStatus } = deps;
  const warnings: string[] = [];
  const snapshot = history.current;
  const none: AiOutcome = { warnings, words: [], applied: false };

  const levels = await deps.readLevels().catch(() => null);
  if (aborted(signal)) return none;

  let transcript: Transcript | null = null;
  if (snapshot.tracks.mic) {
    if (deps.transcribe) {
      onStatus({ step: "transcribing", pct: 0 });
      try {
        await deps.transcribe((pct) => onStatus({ step: "transcribing", pct }), signal);
      } catch (e) {
        if (aborted(signal)) return none;
        const kind = e instanceof TranscribeFailure ? e.kind : "failed";
        if (kind === "noWhisper") warnings.push(SENTENCES.noWhisper);
        else if (kind === "failed") warnings.push(SENTENCES.transcribeFailed);
        if (e instanceof Error && kind === "failed") console.warn("transcription failed", e);
      }
      if (aborted(signal)) return none;
    }
    transcript = await deps.readTranscript().catch(() => null);
    if (aborted(signal)) return none;
  }

  const words = transcript ? cleanWords(transcript.words, levels) : [];
  const project = history.current;
  const settings = aiEdits(project);
  const durationUs = project.durationUs;

  // No transcript at all (failed, declined, no mic): silences from the mic level only.
  const fallbackSpans = !transcript && levels ? levelCuts(levels, { silenceGapUs: DEFAULT_SILENCE_GAP_US, paceUs: settings.paceUs, durationUs }) : undefined;
  if (words.length === 0 && !fallbackSpans) {
    onStatus({ step: "nothing" });
    return { warnings, words, applied: false };
  }

  const candidates = zoomCandidates(events, project);
  let ai: AiResult | null = null;
  let aiFailed = false;
  if (provider && words.length > 0) {
    onStatus({ step: "editing" });
    const input = {
      words,
      sections: transcript?.sections ?? [],
      ruleCuts: ruleCuts(words, levels, { silenceGapUs: DEFAULT_SILENCE_GAP_US, paceUs: settings.paceUs, durationUs }),
      candidates,
    };
    try {
      const results: AiResult[] = [];
      for (const chunk of chunkInput(input, durationUs)) {
        const raw = await provider.editPass(chunk, signal);
        const v = validateResult(raw, chunk);
        if ("refused" in v) throw new AiProviderError("badResult", v.refused);
        results.push(v);
      }
      ai = results.length === 1 ? results[0]! : mergeResults(results, words);
    } catch (e) {
      if (aborted(signal)) return none;
      aiFailed = true;
      warnings.push(providerSentence(e));
      console.warn("AI step failed", e);
    }
  }
  if (aborted(signal)) return none;

  // When the AI step failed, a rerun keeps the last good AI answer (if it still fits the words) and
  // the zooms stay as they were: no fallback zooms appear by themselves.
  const current = history.current;
  if (aiFailed) {
    const last = aiEdits(current).lastResult;
    const v = last ? validateResult(last, { words, sections: [], ruleCuts: [], candidates }) : null;
    ai = v && !("refused" in v) ? v : null;
  }
  const next = buildAiEdits({ project: current, words, levels, candidates, ai, fallbackSpans });
  // No AI answer (it failed, or there were no words to send): zooms stay as they were.
  if (!ai) next.zooms = current.edits.zooms.filter((z) => z.origin === "ai" || z.origin === "auto");

  // Languages of sections with real speech (a near silent section with one "Mm-hmm." is not a language).
  const languages = [
    ...new Set(
      (transcript?.sections ?? [])
        .filter((s) => words.filter((w) => w.startUs >= s.startUs && w.startUs < s.endUs).length >= 5)
        .map((s) => s.language),
    ),
  ];
  const before = history.current;
  // Open checklist topics are matched once more against the whole transcript (better than the live chunks).
  const coverTopics = (p: Project): Project => {
    const open = checklistItems(p).filter((i) => i.atUs === null);
    return open.length > 0 && words.length > 0 ? coverOpenItems(matchTopics(open, words), "transcript")(p) : p;
  };
  history.apply((p) =>
    coverTopics(applyAiPass(
      next,
      { touchedSince: touchedRanges(snapshot, current) },
      {
        at: (deps.now?.() ?? new Date()).toISOString(),
        provider: provider?.name ?? "none",
        model: provider?.model ?? "",
        languages,
        result: ai,
      },
    )(p)),
  );
  const after = history.current;
  const nCuts = after.edits.cuts.filter((c) => c.origin === "ai").length;
  const nZooms = after.edits.zooms.filter((z) => z.origin === "ai").length;
  onStatus({ step: "done", cuts: nCuts, zooms: nZooms, captions: words.length > 0 && settings.kinds.captions });
  return { warnings, words, applied: after !== before };
}

/** "AI edit: 23 cuts, 6 zooms, captions. Ctrl+Z undoes it": names only what happened. */
export function doneText(s: { cuts: number; zooms: number; captions: boolean }): string {
  const parts: string[] = [];
  if (s.cuts) parts.push(`${s.cuts} ${s.cuts === 1 ? "cut" : "cuts"}`);
  if (s.zooms) parts.push(`${s.zooms} ${s.zooms === 1 ? "zoom" : "zooms"}`);
  if (s.captions) parts.push("captions");
  return parts.length ? `AI edit: ${parts.join(", ")}. Ctrl+Z undoes it` : "AI edit: nothing to change.";
}

export const statusText = (s: AiStatus): string =>
  s.step === "transcribing"
    ? `Transcribing ${Math.round(s.pct * 100)}%`
    : s.step === "editing"
      ? "Editing with AI"
      : s.step === "nothing"
        ? "No speech found. Nothing was cut."
        : doneText(s);

export { EMPTY_RESULT };
