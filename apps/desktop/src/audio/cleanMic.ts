import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { audioEdits, type Project } from "@marz/format";
import { isTauri } from "../platform";

/** The noise-cleaned mic copy for the open project (design `2026-11-19-audio-cleanup-design.md`).
 * `browser`: a plain browser cannot make it, the preview plays `mic.wav`. */
export type CleanState =
  | { status: "idle" }
  | { status: "browser" }
  | { status: "cleaning"; dir: string }
  | { status: "ready"; dir: string; file: string }
  | { status: "failed"; dir: string; error: string };

export const useCleanMic = create<{ state: CleanState }>(() => ({ state: { status: "idle" } }));

const set = (state: CleanState) => useCleanMic.setState({ state });

let running: { dir: string; job: Promise<string | null> } | null = null;

/** Make (or find) the cleaned copy for `dir`. Resolves with its path relative to the project, or null
 * when it cannot be made (browser, no mic, FFmpeg failed). Calls for the same folder share one run. */
export function ensureCleanMic(dir: string, micFile: string): Promise<string | null> {
  if (!isTauri()) {
    set({ status: "browser" });
    return Promise.resolve(null);
  }
  const cur = useCleanMic.getState().state;
  if (cur.status === "ready" && cur.dir === dir) return Promise.resolve(cur.file);
  if (running && running.dir === dir) return running.job;
  set({ status: "cleaning", dir });
  const job = invoke<string>("audio_clean_mic", { projectDir: dir, micFile })
    .then((file) => {
      set({ status: "ready", dir, file });
      return file;
    })
    .catch((e: unknown) => {
      console.warn("[audio] noise removal failed", e);
      set({ status: "failed", dir, error: String(e) });
      return null;
    })
    .finally(() => {
      if (running?.job === job) running = null;
    });
  running = { dir, job };
  return job;
}

/** Whether the export should read the cleaned copy: noise removal on, a mic that is heard, and the
 * copy made. Makes the copy first when needed. */
export async function cleanMicForExport(project: Project, dir: string): Promise<boolean> {
  const mic = project.tracks.mic;
  if (!mic || mic.muted || !audioEdits(project).denoise) return false;
  return (await ensureCleanMic(dir, mic.file)) !== null;
}

/** The file the preview should play for the mic: the cleaned copy when it is ready for `dir` and noise
 * removal is on, else the raw mic. */
export function previewMicFile(state: CleanState, dir: string | null, micFile: string, denoise: boolean): string {
  return denoise && state.status === "ready" && state.dir === dir ? state.file : micFile;
}

/** One line for the inspector under the noise switch. */
export function cleanLine(state: CleanState, denoise: boolean): string {
  if (!denoise) return "Preview and export use the original mic";
  switch (state.status) {
    case "browser":
      return "Plays the original mic in the browser. The app cleans it";
    case "cleaning":
      return "Cleaning mic sound";
    case "ready":
      return "Mic cleaned. Preview plays it";
    case "failed":
      return "Could not clean the mic. Export uses the original";
    default:
      return "Cleans when the project opens";
  }
}
