import { isTauri } from "../platform";
import { createHttpStorage } from "./httpStorage";
import { createTauriStorage } from "./tauriStorage";
import type { ProjectStorage } from "./types";

/** Tauri storage for a folder in the app; HTTP storage for a sample name in a plain browser. */
export function pickStorage(dir: string): ProjectStorage {
  return isTauri() ? createTauriStorage(dir) : createHttpStorage(dir);
}
