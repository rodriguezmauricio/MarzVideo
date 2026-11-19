import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TranscribeFailure } from "./runAiPass";

export type ModelStatus = { present: boolean; name: string; bytes: number };
type TranscribeErrorPayload = { kind: "noWhisper" | "noModel" | "noMic" | "failed" | "cancelled"; detail?: string };

const toFailure = (e: unknown): TranscribeFailure => {
  const p = e as TranscribeErrorPayload;
  if (p && typeof p === "object" && "kind" in p) return new TranscribeFailure(p.kind, p.detail ?? p.kind);
  return new TranscribeFailure("failed", String(e));
};

/** Desktop only: `transcript.json` for the project folder (skipped by Rust when it is current). */
export async function transcribeProject(dir: string, onPct: (pct: number) => void, signal: AbortSignal): Promise<void> {
  const unlisten = await listen<{ pct: number }>("transcribe://progress", (e) => onPct(e.payload.pct));
  const onAbort = () => void invoke("transcribe_cancel").catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    await invoke("transcribe", { projectDir: dir });
  } catch (e) {
    throw toFailure(e);
  } finally {
    signal.removeEventListener("abort", onAbort);
    unlisten();
  }
}

export const modelStatus = (): Promise<ModelStatus> => invoke<ModelStatus>("model_status");

/** Downloads the transcription model (only after he said yes). */
export async function downloadModel(onPct: (pct: number) => void): Promise<void> {
  const unlisten = await listen<{ pct: number }>("model://progress", (e) => onPct(e.payload.pct));
  try {
    await invoke("download_model");
  } catch (e) {
    throw toFailure(e);
  } finally {
    unlisten();
  }
}
