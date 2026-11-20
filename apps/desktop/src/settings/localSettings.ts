// The settings that live in the webview's localStorage, read and written in one place (Settings and
// onboarding). The recorder and export code keep reading their own keys as before.
import { readBurn, readLastPreset, writeBurn, writeLastPreset } from "../export/exportUi";
import { PRESETS, type ExportPresetId } from "../export/presets";

/** Defaults for new recordings; the setup bar can still change them per recording. */
export type DeviceDefaults = { micId: string | null; cameraId: string | null; cameraOn: boolean; systemAudio: boolean; logKeys: boolean };

export const DEVICE_DEFAULTS_KEY = "marz.recorder.defaults";
/** Per-monitor setups (recorderStore `setupKey`). */
const SETUP_PREFIX = "marz.recorder.setup.";
const AI_MODEL_KEY = "marz.ai.model";

export const NO_DEVICE_DEFAULTS: DeviceDefaults = { micId: null, cameraId: null, cameraOn: false, systemAudio: false, logKeys: false };

/** Safe access to window.localStorage (can throw in locked-down contexts). */
export function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored device defaults; missing or broken values read as the plain defaults. */
export function readDeviceDefaults(storage: Storage | null | undefined): DeviceDefaults {
  try {
    const o = JSON.parse(storage?.getItem(DEVICE_DEFAULTS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return NO_DEVICE_DEFAULTS;
    return {
      micId: typeof o.micId === "string" ? o.micId : null,
      cameraId: typeof o.cameraId === "string" ? o.cameraId : null,
      cameraOn: o.cameraOn === true,
      systemAudio: o.systemAudio === true,
      logKeys: o.logKeys === true,
    };
  } catch {
    return NO_DEVICE_DEFAULTS;
  }
}

/** Save device defaults and put them into every saved per-monitor setup, so the next recording
 *  uses them whichever monitor it is on. Returns the new defaults. */
export function writeDeviceDefaults(storage: Storage | null | undefined, patch: Partial<DeviceDefaults>): DeviceDefaults {
  const next = { ...readDeviceDefaults(storage), ...patch };
  if (!storage) return next;
  try {
    storage.setItem(DEVICE_DEFAULTS_KEY, JSON.stringify(next));
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(SETUP_PREFIX)) continue;
      try {
        const setup = JSON.parse(storage.getItem(key) ?? "null") as Record<string, unknown> | null;
        if (setup && typeof setup === "object") storage.setItem(key, JSON.stringify({ ...setup, ...patch }));
      } catch {
        // A broken setup is replaced by the default (with these devices) when the recorder opens.
      }
    }
  } catch {
    // Storage blocked or full: not remembered.
  }
  return next;
}

export type AiModel = "sonnet" | "opus";
export const AI_MODELS: readonly AiModel[] = ["sonnet", "opus"];

export function readAiModel(storage: Storage | null | undefined): AiModel {
  try {
    return storage?.getItem(AI_MODEL_KEY) === "opus" ? "opus" : "sonnet";
  } catch {
    return "sonnet";
  }
}

export function writeAiModel(storage: Storage | null | undefined, m: AiModel): void {
  try {
    storage?.setItem(AI_MODEL_KEY, m);
  } catch {
    // Not remembered.
  }
}

export const EXPORT_PRESET_IDS = Object.keys(PRESETS) as ExportPresetId[];
export const presetLabel = (id: ExportPresetId) => PRESETS[id].label;
export const readDefaultPreset = readLastPreset;
export const writeDefaultPreset = writeLastPreset;
export const readBurnCaptions = (storage: Storage | null | undefined, id: ExportPresetId) => readBurn(storage, id, PRESETS[id].burnCaptionsDefault);
export const writeBurnCaptions = writeBurn;
