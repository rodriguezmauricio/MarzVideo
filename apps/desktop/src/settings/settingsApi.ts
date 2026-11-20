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

export type ProviderId = "claude-code" | "anthropic" | "local" | "off";
/** provider.rs `AiConfig`: what settings.json `ai` holds. Never the key. */
export type AiConfig = { provider: ProviderId; anthropicModel: string; localUrl: string; localModel: string };
/** provider.rs `ProviderView`: the config, whether a key is saved (and its last 4 characters), Claude Code's path. */
export type ProviderView = AiConfig & { keySaved: boolean; keyLast4: string | null; claude: string | null };
export type TestResult = { ok: boolean; text: string };

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
  aiProvider(): Promise<ProviderView>;
  /** Rejects with the sentence when refused (an address without http://). */
  setAiProvider(config: AiConfig): Promise<ProviderView>;
  /** Saves the key in Windows Credential Manager. The key never comes back. */
  saveAiKey(key: string): Promise<ProviderView>;
  removeAiKey(): Promise<ProviderView>;
  /** Checks the saved provider without spending anything. */
  testAiProvider(): Promise<TestResult>;
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
  aiProvider: () => invoke<ProviderView>("ai_provider_get"),
  setAiProvider: (config) => invoke<ProviderView>("ai_provider_set", { config }),
  saveAiKey: (key) => invoke<ProviderView>("ai_key_save", { key }),
  removeAiKey: () => invoke<ProviderView>("ai_key_remove"),
  testAiProvider: () => invoke<TestResult>("ai_provider_test"),
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
  let ai: ProviderView = {
    provider: "claude-code",
    anthropicModel: "claude-opus-5-5",
    localUrl: "http://localhost:11434",
    localModel: "",
    keySaved: false,
    keyLast4: null,
    claude: "C:\\Users\\you\\.local\\bin\\claude.exe",
  };
  const pause = () => new Promise((r) => setTimeout(r, 120));
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
    aiProvider: async () => ai,
    setAiProvider: async (c) => {
      const url = c.localUrl.trim().replace(/\/+$/, "") || "http://localhost:11434";
      if (!/^https?:\/\//.test(url)) throw "The address starts with http:// or https://.";
      return (ai = { ...ai, ...c, localUrl: url, localModel: c.localModel.trim() });
    },
    saveAiKey: async (key) => {
      const k = key.trim();
      if (!k) throw "Paste the key first.";
      return (ai = { ...ai, keySaved: true, keyLast4: k.slice(-4) });
    },
    removeAiKey: async () => (ai = { ...ai, keySaved: false, keyLast4: null }),
    testAiProvider: async () => {
      await pause();
      if (ai.provider === "off") return { ok: true, text: "AI is off. Nothing is sent." };
      if (ai.provider === "claude-code") return { ok: true, text: "Claude Code is installed. It uses your Claude subscription." };
      if (ai.provider === "anthropic") return ai.keySaved ? { ok: true, text: `Connected. ${ai.anthropicModel} is ready.` } : { ok: false, text: "No key saved yet." };
      if (!ai.localModel) return { ok: false, text: "Connected. Type a model name. Found: llama3.1:latest, qwen2.5:7b." };
      return ["llama3.1", "qwen2.5:7b"].includes(ai.localModel)
        ? { ok: true, text: `Connected. ${ai.localModel} is ready.` }
        : { ok: false, text: `Connected, but there is no model named ${ai.localModel}. Found: llama3.1:latest, qwen2.5:7b.` };
    },
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
