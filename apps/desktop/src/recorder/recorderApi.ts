// The recorder windows talk to the Tauri shell through this. `?fake` gives a browser-only version
// with sample data for design checks (no Tauri, nothing persisted).
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { PxRect } from "./regionMath";
import type { Monitor, Setup } from "./recorderStore";

export type Mic = { id: string; name: string; default: boolean };
export type BarInfo = { mics: Mic[]; ffmpeg: boolean };

export const NO_MIC = "No microphone found. Recording without sound.";
export const NO_FFMPEG = "FFmpeg is missing. Install it or set MARZ_FFMPEG.";
export const REGION_TOO_SMALL = "Region is too small. Drag at least 64 x 64.";

export interface RecorderApi {
  fake: boolean;
  monitor: Monitor;
  info(): Promise<BarInfo>;
  /** Null when the region is fine, else the sentence to show (from the engine's normalize_region). */
  checkRegion(r: PxRect): Promise<string | null>;
  startMeter(micId: string | null): Promise<void>;
  onLevel(cb: (level: number) => void): () => void;
  fitBar(w: number, h: number, barTop: number): Promise<void>;
  /** Ask the bar to record (from the overlay's hotkey). */
  requestRecord(): void;
  onRecordRequest(cb: () => void): () => void;
  record(setup: Setup): Promise<void>;
  close(): Promise<void>;
}

const params = () => new URLSearchParams(window.location.search);
export const isFake = () => params().has("fake");

function message(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

function tauriApi(): RecorderApi {
  const monitor = (window as unknown as { __MARZ_MONITOR__?: Monitor }).__MARZ_MONITOR__;
  if (!monitor) throw new Error("The recorder window opened without its monitor.");
  const unlistenLater = (p: Promise<() => void>) => () => void p.then((u) => u());
  return {
    fake: false,
    monitor,
    info: () => invoke<BarInfo>("recorder_setup"),
    checkRegion: (rect) =>
      invoke("check_region", { rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) } })
        .then(() => null)
        .catch(message),
    startMeter: (micId) => invoke<void>("start_mic_meter", { micId }),
    onLevel: (cb) => unlistenLater(listen<number>("recorder://level", (e) => cb(e.payload))),
    fitBar: (w, h, barTop) => invoke<void>("fit_bar", { w, h, barTop }),
    requestRecord: () => void emitTo("bar", "recorder://record").catch(() => undefined),
    onRecordRequest: (cb) => unlistenLater(listen("recorder://record", () => cb())),
    record: () => invoke<void>("start_recording"),
    close: () => invoke<void>("close_recorder"),
  };
}

/** Sample monitor: 1440 x 900 CSS at 200%, so the chip reads the mockup's "1920 x 1080". */
export const FAKE_MONITOR: Monitor = { index: 0, name: "Fake display", x: 0, y: 0, width: 2880, height: 1800, scale: 2 };

function fakeApi(): RecorderApi {
  const p = params();
  const error = p.get("error");
  const record = new EventTarget();
  return {
    fake: true,
    monitor: FAKE_MONITOR,
    info: async () => ({
      mics: error === "mic" ? [] : [{ id: "usb", name: "Studio mic (USB)", default: true }, { id: "array", name: "Microphone array", default: false }],
      ffmpeg: error !== "ffmpeg",
    }),
    checkRegion: async (r) => (r.w < 64 || r.h < 64 ? REGION_TOO_SMALL : null),
    startMeter: async () => undefined,
    onLevel: (cb) => {
      cb(0.0316); // -30 dB: half the meter, as in the mockup
      return () => undefined;
    },
    fitBar: async () => undefined,
    requestRecord: () => void record.dispatchEvent(new Event("record")),
    onRecordRequest: (cb) => {
      record.addEventListener("record", cb);
      return () => record.removeEventListener("record", cb);
    },
    record: () => new Promise<void>(() => undefined), // stays at "Starting..."
    close: async () => undefined,
  };
}

let api: RecorderApi | null = null;
export function recorderApi(): RecorderApi {
  api ??= isFake() ? fakeApi() : tauriApi();
  return api;
}
