// The combos in force for the recorder hotkeys, for every label in the app (Home, setup bar,
// recording bar, checklist overlay). Loaded from Rust in each window and updated when Settings
// saves (`settings://hotkeys`). Defaults in the browser.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { isTauri } from "../platform";
import { DEFAULT_BINDINGS, type ActionId, type Bindings } from "./hotkeyMap";

type HotkeyState = { bindings: Bindings; set: (b: Bindings) => void };

export const useHotkeys = create<HotkeyState>((set) => ({
  bindings: DEFAULT_BINDINGS,
  set: (bindings) => set({ bindings: { ...DEFAULT_BINDINGS, ...bindings } }),
}));

/** The combo of one action now, for labels ("Ctrl+Shift+R"). */
export const useHotkey = (id: ActionId): string => useHotkeys((s) => s.bindings[id]);
/** The same outside React (key handlers). */
export const hotkeyNow = (id: ActionId): string => useHotkeys.getState().bindings[id];

let started = false;
/** Once per window: read the combos from Rust and follow later changes. */
export function loadHotkeys(): void {
  if (started || !isTauri()) return;
  started = true;
  void invoke<{ hotkeys: Bindings }>("settings_get").then((v) => useHotkeys.getState().set(v.hotkeys), () => undefined);
  void listen<Bindings>("settings://hotkeys", (e) => useHotkeys.getState().set(e.payload));
}
