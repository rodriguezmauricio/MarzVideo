// Settings and onboarding talk to Rust (src-tauri/src/settings.rs) through this; in a plain browser
// a fake keeps everything in memory so the pages can be designed and checked (`?settings=1`).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import { DEFAULT_BINDINGS, rebound, type Bindings } from "./hotkeyMap";

export type FolderKind = "projects" | "exports" | "archive";

/** settings.rs `View`. */
export type SettingsView = {
  projectsDir: string;
  projectsDefault: boolean;
  exportsDir: string;
  exportsDefault: boolean;
  archiveDir: string | null;
  archiveSuggested: string | null;
  hotkeys: Bindings;
  onboardingDone: boolean;
};

/** settings.rs `AiStatus`. */
export type AiStatus = {
  whisper: string | null;
  modelPresent: boolean;
  modelName: string;
  modelBytes: number;
  claude: string | null;
  whisperDir: string | null;
};

export type Device = { id: string; name: string; default?: boolean };
export type Devices = { mics: Device[]; cameras: Device[] };

export interface SettingsApi {
  get(): Promise<SettingsView>;
  /** Folder dialog; null when cancelled. */
  pickFolder(kind: FolderKind): Promise<SettingsView | null>;
  resetFolder(kind: "projects" | "exports"): Promise<SettingsView>;
  useDrive(): Promise<SettingsView>;
  /** Saves the bindings (only the rebound ones are stored); rejects with the sentence when refused. */
  setHotkeys(all: Bindings): Promise<SettingsView>;
  setOnboardingDone(done: boolean): Promise<void>;
  aiStatus(): Promise<AiStatus>;
  /** Downloads the transcription models (only after his click). */
  downloadModels(onPct: (pct: number) => void): Promise<void>;
  devices(): Promise<Devices>;
  /** Level meter 0..1 for `micId` (null = default) while on; returns a stop function. */
  meter(micId: string | null, onLevel: (level: number) => void): Promise<() => void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

const tauriApi: SettingsApi = {
  get: () => invoke<SettingsView>("settings_get"),
  pickFolder: (kind) => invoke<SettingsView | null>("settings_pick_folder", { kind }),
  resetFolder: (kind) => invoke<SettingsView>("settings_reset_folder", { kind }),
  useDrive: () => invoke<SettingsView>("settings_use_drive"),
  setHotkeys: (all) => invoke<SettingsView>("settings_set_hotkeys", { overrides: rebound(all) }),
  setOnboardingDone: (done) => invoke<void>("settings_set_onboarding", { done }),
  aiStatus: () => invoke<AiStatus>("ai_status"),
  async downloadModels(onPct) {
    const unlisten = await listen<{ pct: number }>("model://progress", (e) => onPct(e.payload.pct));
    try {
      await invoke("download_model");
    } catch (e) {
      const p = e as { detail?: string };
      throw new Error(p && typeof p === "object" && p.detail ? p.detail : message(e));
    } finally {
      unlisten();
    }
  },
  devices: () => invoke<Devices>("settings_devices"),
  async meter(micId, onLevel) {
    const unlisten = await listen<number>("settings://level", (e) => onLevel(e.payload));
    try {
      await invoke("settings_meter", { on: true, micId });
    } catch (e) {
      unlisten();
      throw e;
    }
    return () => {
      unlisten();
      void invoke("settings_meter", { on: false, micId: null }).catch(() => undefined);
    };
  },
};

/** Browser fake: fixed folders, a found Whisper and Claude Code, models not downloaded, a moving meter. */
export function fakeSettingsApi(): SettingsApi {
  let view: SettingsView = {
    projectsDir: "C:\\Users\\you\\Videos\\Marz Recorder",
    projectsDefault: true,
    exportsDir: "C:\\Users\\you\\Videos\\Marz Recorder\\Exports",
    exportsDefault: true,
    archiveDir: null,
    archiveSuggested: "G:\\My Drive\\Marz Recorder",
    hotkeys: { ...DEFAULT_BINDINGS },
    onboardingDone: false,
  };
  let present = false;
  return {
    get: async () => view,
    pickFolder: async (kind) => {
      if (kind === "archive") view = { ...view, archiveDir: "D:\\Archive" };
      else if (kind === "projects") view = { ...view, projectsDir: "D:\\Takes", projectsDefault: false };
      else view = { ...view, exportsDir: "D:\\Exports", exportsDefault: false };
      return view;
    },
    resetFolder: async (kind) => {
      view = kind === "projects" ? { ...view, projectsDir: "C:\\Users\\you\\Videos\\Marz Recorder", projectsDefault: true } : { ...view, exportsDir: "C:\\Users\\you\\Videos\\Marz Recorder\\Exports", exportsDefault: true };
      return view;
    },
    useDrive: async () => (view = { ...view, archiveDir: view.archiveSuggested }),
    setHotkeys: async (all) => (view = { ...view, hotkeys: { ...all } }),
    setOnboardingDone: async (done) => void (view = { ...view, onboardingDone: done }),
    aiStatus: async () => ({
      whisper: "C:\\Users\\you\\AppData\\Roaming\\com.marz.recorder\\whisper\\whisper-cli.exe",
      modelPresent: present,
      modelName: "ggml-large-v3-turbo-q5_0.bin",
      modelBytes: 1_650_000_000,
      claude: "C:\\Users\\you\\.local\\bin\\claude.exe",
      whisperDir: "C:\\Users\\you\\AppData\\Roaming\\com.marz.recorder\\whisper",
    }),
    downloadModels: async (onPct) => {
      for (const p of [0.25, 0.5, 0.75, 1]) {
        await new Promise((r) => setTimeout(r, 150));
        onPct(p);
      }
      present = true;
    },
    devices: async () => ({
      mics: [
        { id: "mic-usb", name: "Studio mic (USB)", default: true },
        { id: "mic-int", name: "Microphone array (built in)" },
      ],
      cameras: [{ id: "cam-int", name: "Integrated Webcam" }],
    }),
    meter: async (_micId, onLevel) => {
      let t = 0;
      const id = setInterval(() => onLevel(0.35 + 0.3 * Math.abs(Math.sin((t += 0.4)))), 50);
      return () => clearInterval(id);
    },
  };
}

let api: SettingsApi | null = null;
export const settingsApi = (): SettingsApi => (api ??= isTauri() ? tauriApi : fakeSettingsApi());

export { message as errorText };
