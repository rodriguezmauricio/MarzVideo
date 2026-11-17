import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@marz/format";
import { create } from "zustand";
import { isTauri } from "../platform";
import { useAppStore } from "../state/appStore";
import { useEditorStore } from "../state/editorStore";
import { exportProject } from "./exportVideo";
import { failureText, panelKey, percent, readLastPreset, writeLastPreset, type PanelState } from "./exportUi";
import { createMemorySink } from "./memorySink";
import { PRESETS, type ExportPresetId } from "./presets";
import { asFailure, cancelLeftoverExports, createTauriSink } from "./tauriSink";

export type ExportPhase = "idle" | "picking" | "exporting" | "done" | "failed";

type ExportState = {
  panel: PanelState;
  /** The row with the accent marker: the preset picked last time. */
  last: ExportPresetId;
  phase: ExportPhase;
  /** Whole percent while exporting. */
  progress: number;
  outPath: string | null;
  /** The project the done line belongs to; an edit (a new project object) brings the save status back. */
  doneFor: Project | null;
  /** The warning bar sentence after a failure. */
  failure: string | null;
  controller: AbortController | null;
  togglePanel: () => void;
  closePanel: () => void;
  highlight: (id: ExportPresetId) => void;
  /** A key while the panel is open. True when the panel used it. */
  key: (code: string) => boolean;
  start: (id: ExportPresetId) => Promise<void>;
  cancel: () => void;
  showInFolder: () => void;
  /** Back to idle (the editor closed). Cancels a running export. */
  reset: () => void;
};

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const FILE_SUFFIX: Record<ExportPresetId, string> = { youtube: "YouTube", vertical: "Vertical" };

/** Exports left running by the page before a reload are cancelled on load; a new one waits for that. */
const leftovers: Promise<void> = isTauri() ? cancelLeftoverExports() : Promise.resolve();

export const useExportStore = create<ExportState>((set, get) => ({
  panel: { open: false, highlight: "youtube" },
  last: "youtube",
  phase: "idle",
  progress: 0,
  outPath: null,
  doneFor: null,
  failure: null,
  controller: null,

  togglePanel() {
    const s = get();
    if (s.phase === "picking" || s.phase === "exporting") return;
    if (s.panel.open) return set({ panel: { ...s.panel, open: false } });
    const last = readLastPreset(storage());
    set({ last, panel: { open: true, highlight: last } });
  },
  closePanel: () => set({ panel: { ...get().panel, open: false } }),
  highlight: (id) => set({ panel: { open: get().panel.open, highlight: id } }),
  key(code) {
    const next = panelKey(get().panel, code);
    if (!next) return false;
    set({ panel: { open: next.open, highlight: next.highlight } });
    if (next.pick) void get().start(next.pick);
    return true;
  },

  async start(id) {
    const s = get();
    if (s.phase === "picking" || s.phase === "exporting") return;
    const { project, events, storage: files } = useEditorStore.getState();
    const dir = useAppStore.getState().dir;
    if (!project || !files || !dir) return;
    writeLastPreset(storage(), id);
    set({ last: id, panel: { open: false, highlight: id }, phase: "picking", failure: null, outPath: null, doneFor: null });

    let outPath: string | null;
    try {
      // The app asks Rust, which runs the save dialog; the browser build keeps the file in memory.
      await leftovers;
      outPath = isTauri() ? await invoke<string | null>("pick_export_path", { projectDir: dir, preset: id }) : `${project.name} ${FILE_SUFFIX[id]}.mp4`;
    } catch (e) {
      console.error("[export] save dialog failed", e);
      // Rust's sentence, e.g. "Pick a folder outside the project".
      return set({ phase: "failed", failure: failureText(asFailure(e)) });
    }
    if (!outPath) return set({ phase: "idle" });

    const controller = new AbortController();
    set({ phase: "exporting", progress: 0, controller });
    try {
      const report = await exportProject({
        project,
        events,
        storage: files,
        sink: isTauri() ? createTauriSink() : createMemorySink(),
        preset: PRESETS[id],
        projectDir: dir,
        outPath,
        signal: controller.signal,
        onProgress: (p) => {
          const pc = percent(p);
          if (pc !== get().progress) set({ progress: pc });
        },
      });
      if (get().controller !== controller) return;
      set({ phase: "done", outPath: report.outPath, doneFor: useEditorStore.getState().project, controller: null, progress: 100 });
    } catch (e) {
      if (get().controller !== controller) return;
      if (controller.signal.aborted) return set({ phase: "idle", controller: null, progress: 0 });
      console.error("[export] failed", e);
      set({ phase: "failed", failure: failureText(e), controller: null, progress: 0 });
    }
  },

  cancel() {
    // exportProject sees the abort between frames and cancels the sink (FFmpeg killed, .part removed).
    get().controller?.abort();
  },

  showInFolder() {
    const path = get().outPath;
    if (path && isTauri()) void invoke("show_in_folder", { path }).catch((e: unknown) => console.error("[export] show in folder", e));
  },

  reset() {
    get().controller?.abort();
    set({ panel: { open: false, highlight: get().last }, phase: "idle", progress: 0, outPath: null, doneFor: null, failure: null, controller: null });
  },
}));

if (import.meta.env?.DEV) (window as unknown as { __marzExportStore: typeof useExportStore }).__marzExportStore = useExportStore;
