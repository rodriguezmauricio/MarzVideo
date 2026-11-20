// Reads and writes the saved looks: `looks.json` through Rust (src-tauri/src/looks.rs) in the app,
// localStorage `marz.looks` in a plain browser.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";
import { EMPTY_LOOK_FILE, parseLookFile, type LookFile } from "./lookFile";

export const LOOKS_KEY = "marz.looks";

export interface LooksApi {
  get(): Promise<LookFile>;
  set(file: LookFile): Promise<void>;
}

const tauriApi: LooksApi = {
  get: async () => parseLookFile(await invoke<unknown>("looks_get")),
  set: (file) => invoke<void>("looks_set", { file }),
};

const browserApi: LooksApi = {
  get: async () => {
    try {
      const t = localStorage.getItem(LOOKS_KEY);
      return t ? parseLookFile(JSON.parse(t)) : EMPTY_LOOK_FILE;
    } catch {
      return EMPTY_LOOK_FILE;
    }
  },
  set: async (file) => {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(file));
  },
};

export const looksApi = (): LooksApi => (isTauri() ? tauriApi : browserApi);
