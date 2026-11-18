import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { isTauri } from "../platform";
import { flushAutosave } from "./editorStore";

export type Screen = "home" | "editor";

type AppState = {
  screen: Screen;
  /** The open project: a folder in the app, a sample name in the browser. */
  dir: string | null;
  openProject: (dir: string) => void;
  goHome: () => Promise<void>;
};

/** The app opens on Home. In a plain browser `/` keeps opening the editor (`?project=demo`), and
 *  `?home=fake` (or `?home=empty`) opens Home with fake rows for the design check. */
function initial(): Pick<AppState, "screen" | "dir"> {
  const params = new URLSearchParams(location.search);
  if (isTauri() || params.has("home")) return { screen: "home", dir: null };
  return { screen: "editor", dir: params.get("project") ?? "demo" };
}

export const useAppStore = create<AppState>((set) => ({
  ...initial(),
  openProject: (dir) => set({ screen: "editor", dir }),
  async goHome() {
    // A failed save keeps the editor open: the strip shows "Save failed. Retrying..." and the
    // edit is retried; leaving now would drop it.
    if (!(await flushAutosave())) return;
    set({ screen: "home", dir: null });
  },
}));

/** In the app: a recording that was just stopped opens in the editor (Rust sends its folder,
 *  already allowed for the editor, as `recorder://open-project`). */
export function openStoppedRecordings(): void {
  if (!isTauri()) return;
  void listen<string>("recorder://open-project", async (e) => {
    await flushAutosave();
    useAppStore.getState().openProject(e.payload);
  });
}

/** In the app: closing the window saves the last edit first. Rust holds the close and sends
 *  `app://flush`; the page saves and asks Rust to close. If the save fails, the window stays while
 *  the retry runs; Rust closes it after 3 s either way (src-tauri/src/close.rs). */
export function saveBeforeClose(): void {
  if (!isTauri()) return;
  void listen("app://flush", async () => {
    if (await flushAutosave()) await invoke("close_main");
  });
}
