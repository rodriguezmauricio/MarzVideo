import { create } from "zustand";
import { parseEvents, parseProject, type MarzEvent, type Project } from "@marz/format";
import { History, type Command } from "@marz/timeline";
import { createHttpStorage } from "../storage/httpStorage";
import type { ProjectStorage } from "../storage/types";

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
  /** Bumped by seek so the player knows a jump was requested, as opposed to a normal playback tick. */
  seekRequest: { us: number; n: number };
  load: (name: string) => Promise<void>;
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
  seekRequest: { us: 0, n: 0 },

  async load(name) {
    set({ status: "loading", error: null });
    try {
      const storage = createHttpStorage(name);
      const project = parseProject(JSON.parse(await storage.readText("project.json")));
      const { events } = parseEvents(await storage.readText("events.jsonl"));
      events.sort((a, b) => a.tUs - b.tUs);
      const history = new History(project);
      history.subscribe(() => set({ project: history.current }));
      set({ status: "ready", storage, project, events, history, playheadUs: 0, playing: false });
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
