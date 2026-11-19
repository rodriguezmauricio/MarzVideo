import { buildAiEdits, cleanWords, micLevels, validateResult, zoomCandidates, type AiResult, type Levels } from "@marz/autoedit";
import { aiEdits, type Project } from "@marz/format";
import { setAiKinds, setAiPace } from "@marz/timeline";
import { isTauri } from "../platform";
import { useAppStore } from "../state/appStore";
import { useEditorStore } from "../state/editorStore";
import { readTranscript } from "../storage/transcript";
import { pickProvider } from "./pickProvider";
import { runAiPass } from "./runAiPass";
import { downloadModel, modelStatus, transcribeProject } from "./transcribeApi";

let running: AbortController | null = null;

/** Mic levels for the project (null without a mic or when it cannot be read). */
async function readLevels(): Promise<Levels | null> {
  const { storage, project } = useEditorStore.getState();
  const mic = project?.tracks.mic;
  if (!storage || !mic) return null;
  try {
    const res = await fetch(storage.fileUrl(mic.file));
    if (!res.ok) return null;
    return micLevels(await res.arrayBuffer(), mic.offsetUs);
  } catch (e) {
    console.warn("mic levels unavailable", e);
    return null;
  }
}

/** After opening a project: the transcript words for captions and the Captions lane. */
export async function loadTranscriptWords(): Promise<void> {
  const s = useEditorStore.getState();
  if (!s.storage) return;
  const storage = s.storage;
  const t = await readTranscript(storage);
  if (!t || useEditorStore.getState().storage !== storage) return;
  const levels = await readLevels();
  if (useEditorStore.getState().storage !== storage) return;
  useEditorStore.getState().setTranscript(cleanWords(t.words, levels), t.sections, levels);
}

/** Stops a running pass (closing the project, opening another). Nothing is written. */
export function abortAiPass(): void {
  running?.abort();
  running = null;
}

/** The AI pass, from Stop (`?ai=1`) or the Edit with AI row. In the app it first checks for the
 * transcription model and asks before downloading it. */
export async function startAiPass(): Promise<void> {
  const s = useEditorStore.getState();
  if (!s.history || !s.storage || s.ai.running) return;
  if (isTauri() && s.project?.tracks.mic) {
    try {
      const m = await modelStatus();
      if (!m.present) {
        s.setAi({ ask: "model", warning: null, status: null });
        return; // answerModelAsk continues
      }
    } catch (e) {
      console.warn("model status unavailable", e);
    }
  }
  await run(true);
}

/** "Download" or "Not now" on the model ask. */
export async function answerModelAsk(download: boolean): Promise<void> {
  const s = useEditorStore.getState();
  s.setAi({ ask: null });
  if (!download) return run(false);
  s.setAi({ downloadPct: 0, running: true });
  try {
    await downloadModel((pct) => useEditorStore.getState().setAi({ downloadPct: pct }));
    useEditorStore.getState().setAi({ downloadPct: null, running: false });
    await run(true);
  } catch (e) {
    console.warn("model download failed", e);
    useEditorStore.getState().setAi({ downloadPct: null, running: false, warning: "The transcription model did not download. Only silences were cut." });
    await run(false, true);
  }
}

async function run(withTranscription: boolean, keepWarning = false): Promise<void> {
  const s = useEditorStore.getState();
  const history = s.history;
  const storage = s.storage;
  if (!history || !storage) return;
  abortAiPass();
  const ac = new AbortController();
  running = ac;
  const dir = useAppStore.getState().dir;
  s.setAi({ running: true, status: null, ...(keepWarning ? {} : { warning: null }) });
  try {
    const out = await runAiPass({
      history,
      events: s.events,
      provider: pickProvider(),
      transcribe: withTranscription && isTauri() && dir ? (onPct, signal) => transcribeProject(dir, onPct, signal) : null,
      readTranscript: () => readTranscript(storage),
      readLevels,
      onStatus: (status) => {
        if (!ac.signal.aborted) useEditorStore.getState().setAi({ status });
      },
      signal: ac.signal,
    });
    if (ac.signal.aborted) return;
    const now = useEditorStore.getState();
    const levels = await readLevels();
    if (!ac.signal.aborted) {
      const t = await readTranscript(storage);
      now.setTranscript(out.words, t?.sections ?? [], levels);
      const prev = keepWarning ? now.ai.warning : null;
      now.setAi({ running: false, warning: out.warnings[0] ?? prev });
    }
  } catch (e) {
    console.error("AI pass failed", e);
    if (!ac.signal.aborted) useEditorStore.getState().setAi({ running: false, status: null, warning: "The AI step failed. Mistakes and AI zooms were skipped." });
  } finally {
    if (running === ac) running = null;
  }
}

/** The AI edits rebuilt for new settings, from the kept AI answer (no AI call). */
function rebuild(project: Project) {
  const s = useEditorStore.getState();
  const words = s.words;
  const candidates = zoomCandidates(s.events, project);
  const last = aiEdits(project).lastResult;
  const v = last ? validateResult(last, { words, sections: [], ruleCuts: [], candidates }) : null;
  const ai: AiResult | null = v && !("refused" in v) ? v : null;
  return buildAiEdits({ project, words, levels: s.levels, candidates, ai });
}

const withAi = (p: Project, patch: Partial<ReturnType<typeof aiEdits>>): Project => ({
  ...p,
  edits: { ...p.edits, ai: { ...aiEdits(p), ...patch } },
});

/** The pace slider: re-applies padding to the AI cuts without calling the AI. */
export function setPace(paceUs: number): void {
  const s = useEditorStore.getState();
  if (!s.project || s.words.length === 0) {
    if (s.project) s.apply(setAiPace(paceUs, { cuts: s.project.edits.cuts.filter((c) => c.origin === "ai") }));
    return;
  }
  const next = rebuild(withAi(s.project, { paceUs }));
  s.apply(setAiPace(paceUs, { cuts: next.cuts }));
}

/** A kind toggle (Silences, Ums, Mistakes, AI zooms, Captions). */
export function setKind(kind: "silences" | "fillers" | "mistakes" | "zooms" | "captions", on: boolean): void {
  const s = useEditorStore.getState();
  if (!s.project) return;
  const kinds = { ...aiEdits(s.project).kinds, [kind]: on };
  if (s.words.length === 0) {
    s.apply(setAiKinds(kinds, { cuts: s.project.edits.cuts.filter((c) => c.origin === "ai"), zooms: s.project.edits.zooms.filter((z) => z.origin === "ai") }));
    return;
  }
  const next = rebuild(withAi(s.project, { kinds }));
  s.apply(setAiKinds(kinds, next));
}
