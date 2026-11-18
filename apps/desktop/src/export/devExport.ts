import { useEditorStore } from "../state/editorStore";
import { exportProject } from "./exportVideo";
import { createMemorySink } from "./memorySink";
import { PRESETS, type ExportPresetId } from "./presets";

export type DevExportResult = { preset: ExportPresetId; frames: number; bytes: number; seconds: number; data: Uint8Array } | { error: string };

declare global {
  interface Window {
    __marzExport?: Promise<DevExportResult>;
  }
}

/** Dev page `?project=<name>&export=memory&preset=youtube|vertical`: once the editor has loaded, export to
 *  the memory sink and log frames, bytes and seconds. The result is on `window.__marzExport`. */
export function runDevExport(params: URLSearchParams): void {
  const id = (params.get("preset") ?? "youtube") as ExportPresetId;
  const preset = PRESETS[id] ?? PRESETS.youtube;
  window.__marzExport = new Promise<DevExportResult>((resolve) => {
    const start = async () => {
      const { project, events, storage } = useEditorStore.getState();
      const sink = createMemorySink();
      let frames = 0;
      const t0 = performance.now();
      try {
        await exportProject({
          project: project!,
          events,
          storage: storage!,
          sink,
          preset,
          projectDir: params.get("project") ?? "",
          outPath: "memory",
          signal: new AbortController().signal,
          onProgress: () => frames++,
        });
        const seconds = (performance.now() - t0) / 1000;
        const data = sink.bytes();
        console.log(`[export] ${preset.id}: ${frames} frames, ${data.byteLength} bytes, ${seconds.toFixed(2)} s`);
        resolve({ preset: preset.id, frames, bytes: data.byteLength, seconds, data });
      } catch (e) {
        console.error("[export] failed", e);
        resolve({ error: e instanceof Error ? e.message : String(e) });
      }
    };
    let done = false;
    const check = () => {
      const s = useEditorStore.getState();
      if (done || (s.status !== "ready" && s.status !== "error")) return;
      done = true;
      unsub();
      if (s.status === "ready") void start();
      else resolve({ error: s.error ?? "load failed" });
    };
    const unsub = useEditorStore.subscribe(check);
    check();
  });
}
