import { create } from "zustand";
import { parseProject, serializeProject, type CaptionPresetId, type MarzEvent, type Project, type Section, type Word } from "@marz/format";
import type { Levels } from "@marz/autoedit";
import type { AiStatus } from "../ai/runAiPass";
import { History, type Command } from "@marz/timeline";
import { createAutosave, type SaveStatus } from "../storage/autosave";
import type { ProjectStorage } from "../storage/types";
import { loadEventsOrEmpty } from "./loadEvents";

export type Selection = { kind: "zoom" | "cut" | "word"; id: string } | null;

/** The AI pass as the editor shows it: status line, warning, the model download ask. */
export type AiUi = {
  running: boolean;
  status: AiStatus | null;
  warning: string | null;
  ask: "model" | null;
  downloadPct: number | null;
};
export const IDLE_AI: AiUi = { running: false, status: null, warning: null, ask: null, downloadPct: null };

const PRESET_KEY = "marz.captionPreset";
/** The caption preset the preview showed last (M2 stored the look: "highlight" was the vertical one). */
const savedPreset = (): CaptionPresetId => {
  try {
    const v = localStorage.getItem(PRESET_KEY) ?? localStorage.getItem("marz.captionLook");
    return v === "vertical" || v === "highlight" ? "vertical" : "youtube";
  } catch {
    return "youtube";
  }
};

const AUTOSAVE_DELAY_MS = 2000;
let autosave: ReturnType<typeof createAutosave> | null = null;

/** Save any pending edit right now (before leaving the project or closing the window). True when
 *  everything is saved. */
export const flushAutosave = (): Promise<boolean> => autosave?.flush() ?? Promise.resolve(true);

type EditorState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  storage: ProjectStorage | null;
  project: Project | null;
  events: MarzEvent[];
  history: History | null;
  /** Playhead in SOURCE time (microseconds). The timeline shows source time with cuts as blocks. */
  playheadUs: number;
  playing: boolean;
  /** Shown to the user when the recording opened but something was missing (e.g. no events file). */
  warning: string | null;
  saveStatus: SaveStatus;
  selection: Selection;
  /** Transcript words with Whisper's words over silence dropped (captions and the AI pass use them). */
  words: Word[];
  sections: Section[];
  /** Mic loudness, for the rules and the pace slider (null: no mic or not read yet). */
  levels: Levels | null;
  /** The export preset whose caption style the preview shows: the one last picked in the Captions
   * block or the export panel. */
  captionPreset: CaptionPresetId;
  setCaptionPreset: (preset: CaptionPresetId) => void;
  /** Which inspector tab shows (the Transcript tab exists only with a transcript). */
  inspectorTab: "edit" | "transcript";
  setInspectorTab: (tab: "edit" | "transcript") => void;
  /** The word being fixed in place in the Transcript panel. */
  transcriptEditing: string | null;
  setTranscriptEditing: (id: string | null) => void;
  ai: AiUi;
  setAi: (patch: Partial<AiUi>) => void;
  setTranscript: (words: Word[], sections: Section[], levels: Levels | null) => void;
  select: (sel: Selection) => void;
  /** Bumped by seek so the player knows a jump was requested, as opposed to a normal playback tick. */
  seekRequest: { us: number; n: number };
  load: (storage: ProjectStorage) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (srcUs: number) => void;
  /** Used by the player each frame; does not request a seek. */
  tick: (srcUs: number) => void;
  apply: (command: Command) => void;
  undo: () => void;
  redo: () => void;
};

export const useEditorStore = create<EditorState>((set, get) => ({
  status: "idle",
  error: null,
  storage: null,
  project: null,
  events: [],
  history: null,
  playheadUs: 0,
  playing: false,
  warning: null,
  saveStatus: "saved",
  selection: null,
  select: (selection) => set({ selection }),
  words: [],
  sections: [],
  levels: null,
  captionPreset: savedPreset(),
  setCaptionPreset: (captionPreset) => {
    try {
      localStorage.setItem(PRESET_KEY, captionPreset);
    } catch {
      /* the preset is a convenience */
    }
    set({ captionPreset });
  },
  inspectorTab: "edit",
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  transcriptEditing: null,
  setTranscriptEditing: (transcriptEditing) => set({ transcriptEditing }),
  ai: IDLE_AI,
  setAi: (patch) => set({ ai: { ...get().ai, ...patch } }),
  setTranscript: (words, sections, levels) => set({ words, sections, levels }),
  seekRequest: { us: 0, n: 0 },

  async load(storage) {
    set({ status: "loading", error: null });
    try {
      const project = parseProject(JSON.parse(await storage.readText("project.json")));
      const { events, warning } = await loadEventsOrEmpty(() => storage.readText("events.jsonl"));
      const history = new History(project);
      autosave = createAutosave(() => storage.writeProjectJson(serializeProject(history.current)), AUTOSAVE_DELAY_MS, (saveStatus) => set({ saveStatus }));
      history.subscribe(() => {
        const sel = get().selection;
        const p = history.current;
        const stillThere =
          !sel || sel.kind === "word" || (sel.kind === "zoom" ? p.edits.zooms : p.edits.cuts).some((x) => x.id === sel.id);
        // The "AI edit: ..." line stays until the next edit.
        const ai = get().ai;
        const clearDone = ai.status?.step === "done" || ai.status?.step === "nothing";
        set({ project: p, selection: stillThere ? sel : null, ...(clearDone && !ai.running ? { ai: { ...ai, status: null } } : {}) });
        autosave?.schedule();
      });
      set({ status: "ready", storage, project, events, warning, saveStatus: "saved", history, playheadUs: 0, playing: false, selection: null, words: [], sections: [], levels: null, ai: IDLE_AI });
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },

  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  togglePlay: () => set({ playing: !get().playing }),
  seek: (srcUs) => {
    const duration = get().project?.durationUs ?? 0;
    const us = Math.min(Math.max(0, Math.round(srcUs)), duration);
    set({ playheadUs: us, seekRequest: { us, n: get().seekRequest.n + 1 } });
  },
  tick: (srcUs) => set({ playheadUs: srcUs }),
  apply: (command) => get().history?.apply(command),
  undo: () => get().history?.undo(),
  redo: () => get().history?.redo(),
}));

if (import.meta.env?.DEV) (window as unknown as { __marz: typeof useEditorStore }).__marz = useEditorStore;
