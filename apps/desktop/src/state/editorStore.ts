import { create } from "zustand";
import { parseProject, serializeProject, type MarzEvent, type Project } from "@marz/format";
import { History, type Command } from "@marz/timeline";
import { createAutosave, type SaveStatus } from "../storage/autosave";
import type { ProjectStorage } from "../storage/types";
import { loadEventsOrEmpty } from "./loadEvents";

export type Selection = { kind: "zoom" | "cut"; id: string } | null;

const AUTOSAVE_DELAY_MS = 2000;
let autosave: ReturnType<typeof createAutosave> | null = null;

/** Save any pending edit right now (used before the page closes). */
export const flushAutosave = (): Promise<void> => autosave?.flush() ?? Promise.resolve();

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
          !sel || (sel.kind === "zoom" ? p.edits.zooms : p.edits.cuts).some((x) => x.id === sel.id);
        set({ project: p, selection: stillThere ? sel : null });
        autosave?.schedule();
      });
      set({ status: "ready", storage, project, events, warning, saveStatus: "saved", history, playheadUs: 0, playing: false, selection: null });
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
