import { invoke } from "@tauri-apps/api/core";
import { captionStyleFor, parseArchiveState, usesProxies, type Project } from "@marz/format";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { isTauri } from "../platform";
import { useAppStore } from "../state/appStore";
import { useEditorStore } from "../state/editorStore";
import { exportProject } from "./exportVideo";
import { failureText, panelKey, percent, readBurn, readLastPreset, writeBurn, writeLastPreset, type PanelState } from "./exportUi";
import { captionLines, toSrt, toVtt } from "@marz/autoedit";
import { captionBlocks, captionStyle, loadCaptionFont } from "../ai/captionStyle";
import { cleanMicForExport } from "../audio/cleanMic";
import { createMemorySink } from "./memorySink";
import { PRESETS, type ExportPresetId } from "./presets";
import { asFailure, cancelLeftoverExports, createTauriSink } from "./tauriSink";

export type ExportPhase = "idle" | "picking" | "exporting" | "done" | "failed";

/** Raw files removed: the ask before an export from proxies (DESIGN-SYSTEM.md Export, "Proxy ask"). */
export type ProxyAsk = { id: ExportPresetId; restorePct: number | null; error: string | null };

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
  /** "Burn captions" per preset (shown only for a project with a transcript). */
  burn: Record<ExportPresetId, boolean>;
  toggleBurn: (id: ExportPresetId) => void;
  togglePanel: () => void;
  closePanel: () => void;
  highlight: (id: ExportPresetId) => void;
  /** A key while the panel is open. True when the panel used it. */
  key: (code: string) => boolean;
  start: (id: ExportPresetId, fromProxies?: boolean) => Promise<void>;
  proxyAsk: ProxyAsk | null;
  /** "export": export from the proxies. "restore": copy the raw files back, then export. "cancel": nothing. */
  answerProxyAsk: (answer: "export" | "restore" | "cancel") => Promise<void>;
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
  proxyAsk: null,
  burn: {
    youtube: readBurn(storage(), "youtube", PRESETS.youtube.burnCaptionsDefault),
    vertical: readBurn(storage(), "vertical", PRESETS.vertical.burnCaptionsDefault),
  },
  toggleBurn(id) {
    const on = !get().burn[id];
    writeBurn(storage(), id, on);
    set({ burn: { ...get().burn, [id]: on } });
  },

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
    if (get().panel.open && code === "KeyB" && useEditorStore.getState().words.length > 0) {
      get().toggleBurn(get().panel.highlight);
      return true;
    }
    const next = panelKey(get().panel, code);
    if (!next) return false;
    set({ panel: { open: next.open, highlight: next.highlight } });
    if (next.pick) void get().start(next.pick);
    return true;
  },

  async start(id, fromProxies = false) {
    const s = get();
    if (s.phase === "picking" || s.phase === "exporting") return;
    const { project, events, storage: files, archive } = useEditorStore.getState();
    const dir = useAppStore.getState().dir;
    if (!project || !files || !dir) return;
    const proxies = usesProxies(archive);
    if (proxies && !fromProxies) return set({ proxyAsk: { id, restorePct: null, error: null }, panel: { open: false, highlight: id } });
    set({ proxyAsk: null });
    writeLastPreset(storage(), id);
    // The preview shows the caption style of the preset last picked.
    useEditorStore.getState().setCaptionPreset(id);
    const words = useEditorStore.getState().words;
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
      const look = captionStyleFor(project, id);
      let captions = null;
      if (words.length > 0 && get().burn[id]) {
        const style = captionStyle();
        await loadCaptionFont(style.family);
        captions = { blocks: captionBlocks(project, words, look), look, style };
      }
      // Noise removal: make (or find) the cleaned mic copy first; without it the export uses mic.wav.
      const cleanMic = isTauri() ? await cleanMicForExport(project, dir) : false;
      const report = await exportProject({
        project,
        cleanMic,
        events,
        storage: files,
        proxies,
        sink: isTauri() ? createTauriSink() : createMemorySink(),
        preset: PRESETS[id],
        projectDir: dir,
        outPath,
        signal: controller.signal,
        captions,
        onProgress: (p) => {
          const pc = percent(p);
          if (pc !== get().progress) set({ progress: pc });
        },
      });
      if (get().controller !== controller) return;
      // The .srt and .vtt beside the MP4 whenever there is a transcript (subtitle lines with the
      // edited text, output times, after cuts).
      if (isTauri() && words.length > 0) {
        const lines = captionLines(project, words, "subtitles");
        const srt = toSrt(lines);
        if (srt) await invoke("export_write_srt", { outPath: report.outPath, text: srt }).catch((e: unknown) => console.error("[export] srt", e));
        const vtt = toVtt(lines);
        if (vtt) await invoke("export_write_vtt", { outPath: report.outPath, text: vtt }).catch((e: unknown) => console.error("[export] vtt", e));
      }
      set({ phase: "done", outPath: report.outPath, doneFor: useEditorStore.getState().project, controller: null, progress: 100 });
    } catch (e) {
      if (get().controller !== controller) return;
      if (controller.signal.aborted) return set({ phase: "idle", controller: null, progress: 0 });
      console.error("[export] failed", e);
      set({ phase: "failed", failure: failureText(e), controller: null, progress: 0 });
    }
  },

  async answerProxyAsk(answer) {
    const ask = get().proxyAsk;
    if (!ask || ask.restorePct !== null) return;
    if (answer === "cancel") return set({ proxyAsk: null });
    if (answer === "export") return get().start(ask.id, true);
    const dir = useAppStore.getState().dir;
    const base = useEditorStore.getState().baseStorage;
    if (!dir || !base || !isTauri()) return set({ proxyAsk: { ...ask, error: "Restore needs the app." } });
    set({ proxyAsk: { ...ask, restorePct: 0, error: null } });
    const un = await listen<{ dir: string; step: string; pct: number }>("archive://progress", (e) => {
      const cur = get().proxyAsk;
      if (cur && e.payload.dir === dir && e.payload.step === "restoring") set({ proxyAsk: { ...cur, restorePct: Math.floor(e.payload.pct * 100) } });
    });
    try {
      await invoke("restore_raw_files", { dir });
      const archive = parseArchiveState(JSON.parse(await base.readText("archive.json")));
      useEditorStore.getState().setArchive(archive);
      set({ proxyAsk: null });
      await get().start(ask.id);
    } catch (e) {
      set({ proxyAsk: { ...ask, restorePct: null, error: `Could not restore the raw files. ${e instanceof Error ? e.message : String(e)}` } });
    } finally {
      un();
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
    set({ panel: { open: false, highlight: get().last }, phase: "idle", progress: 0, outPath: null, doneFor: null, failure: null, controller: null, proxyAsk: null });
  },
}));

if (import.meta.env?.DEV) (window as unknown as { __marzExportStore: typeof useExportStore }).__marzExportStore = useExportStore;
