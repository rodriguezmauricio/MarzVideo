import { create } from "zustand";
import { cameraScenes, checklistEdits, checklistItems, cursorSections, EMPTY_ARCHIVE_STATE, parseArchiveState, type ArchiveState, drawingStrokes, parseProject, verticalEdits, serializeProject, type CaptionPresetId, type MarzEvent, type Project, type Section, type Word } from "@marz/format";
import type { Levels } from "@marz/autoedit";
import type { AiStatus } from "../ai/runAiPass";
import { History, importLiveChecklist, importLiveCursor, importLiveDrawings, importLiveLayouts, type Command } from "@marz/timeline";
import { createAutosave, type SaveStatus } from "../storage/autosave";
import type { ProjectStorage } from "../storage/types";
import { withMedia } from "../storage/withMedia";
import { loadEventsOrEmpty } from "./loadEvents";

export type InspectorTab = "edit" | "transcript" | "checklist";

export type Selection = { kind: "zoom" | "cut" | "word" | "layout" | "cursor" | "drawing" | "frame" | "camera"; id: string } | null;

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
  /** Media URLs follow `archive.json` (proxies once the raw files are removed). */
  storage: ProjectStorage | null;
  /** The folder's own storage, without the proxy mapping. */
  baseStorage: ProjectStorage | null;
  /** `archive.json`: archive record, proxies, removed raw files. */
  archive: ArchiveState;
  /** New archive state (after a restore): media URLs switch at once. */
  setArchive: (archive: ArchiveState) => void;
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
  /** Which inspector tab shows (Transcript only with a transcript, Checklist only with a checklist). */
  inspectorTab: InspectorTab;
  setInspectorTab: (tab: InspectorTab) => void;
  /** The word being fixed in place in the Transcript panel. */
  transcriptEditing: string | null;
  setTranscriptEditing: (id: string | null) => void;
  /** The preview shows the smart vertical picture (and the Vertical lane shows). */
  verticalPreview: boolean;
  toggleVerticalPreview: () => void;
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
  baseStorage: null,
  archive: EMPTY_ARCHIVE_STATE,
  setArchive: (archive) => {
    const base = get().baseStorage;
    set({ archive, storage: base ? withMedia(base, archive) : get().storage });
  },
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
  verticalPreview: false,
  toggleVerticalPreview: () => {
    const on = !get().verticalPreview;
    // A Frame block selection only makes sense while its lane shows.
    set({ verticalPreview: on, ...(!on && get().selection?.kind === "frame" ? { selection: null } : {}) });
  },
  ai: IDLE_AI,
  setAi: (patch) => set({ ai: { ...get().ai, ...patch } }),
  setTranscript: (words, sections, levels) => set({ words, sections, levels }),
  seekRequest: { us: 0, n: 0 },

  async load(storage) {
    set({ status: "loading", error: null });
    try {
      const read = parseProject(JSON.parse(await storage.readText("project.json")));
      const { events, warning } = await loadEventsOrEmpty(() => storage.readText("events.jsonl"));
      // Optional: no archive.json (or an unreadable one) means the raw files are here.
      const archive = await storage.readText("archive.json").then((t) => parseArchiveState(JSON.parse(t)), () => EMPTY_ARCHIVE_STATE);
      // Layout hotkeys pressed while recording become Live layout blocks the first time the take
      // opens (not an undo step; saved with the next autosave). Live drawing strokes and live hide cursor too.
      const project = importLiveCursor(events)(importLiveChecklist(events)(importLiveDrawings(events)(importLiveLayouts(events)(read))));
      // The first open of a take with a checklist topic not covered shows the Checklist tab (the flag after Stop).
      const firstCheck = !checklistEdits(read).liveImported && checklistEdits(project).liveImported === true;
      const flagChecklist = firstCheck && checklistItems(project).some((i) => i.atUs === null);
      const history = new History(project);
      autosave = createAutosave(() => storage.writeProjectJson(serializeProject(history.current)), AUTOSAVE_DELAY_MS, (saveStatus) => set({ saveStatus }));
      history.subscribe(() => {
        const sel = get().selection;
        const p = history.current;
        const stillThere =
          !sel ||
          sel.kind === "word" ||
          (sel.kind === "camera" && !!p.tracks.camera) ||
          (sel.kind === "frame"
            ? verticalEdits(p).holds
            : sel.kind === "layout"
            ? cameraScenes(p)
            : sel.kind === "cursor"
              ? cursorSections(p)
              : sel.kind === "drawing"
                ? drawingStrokes(p)
                : sel.kind === "zoom"
                  ? p.edits.zooms
                  : p.edits.cuts
          ).some((x) => x.id === sel.id);
        // The "AI edit: ..." line stays until the next edit.
        const ai = get().ai;
        const clearDone = ai.status?.step === "done" || ai.status?.step === "nothing";
        set({ project: p, selection: stillThere ? sel : null, ...(clearDone && !ai.running ? { ai: { ...ai, status: null } } : {}) });
        autosave?.schedule();
      });
      set({
        status: "ready",
        storage: withMedia(storage, archive),
        baseStorage: storage,
        archive,
        project,
        events,
        warning,
        saveStatus: "saved",
        history,
        playheadUs: 0,
        playing: false,
        selection: null,
        words: [],
        sections: [],
        levels: null,
        ai: IDLE_AI,
        inspectorTab: flagChecklist ? "checklist" : "edit",
      });
      if (project !== read) autosave.schedule();
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
