// The recorder windows talk to the Tauri shell through this. `?fake` gives a browser-only version
// with sample data for design checks (no Tauri, nothing persisted).
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { PxRect } from "./regionMath";
import type { Monitor, RecordOptions } from "./recorderStore";

export type Mic = { id: string; name: string; default: boolean };
/** `recorder://state` from Rust (recording.rs `RecState`). `activePreset` is a session id ("p1"). */
export type RecState = { recording: boolean; paused: boolean; muted: boolean; mic: boolean; activePreset: string | null; recUs: number };
export const IDLE: RecState = { recording: false, paused: false, muted: false, mic: false, activePreset: null, recUs: 0 };
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
  fitBar(w: number, h: number, barTop: number, recording: boolean): Promise<void>;
  /** Ask the bar to record (from the overlay's key, or the global hotkey through Rust). */
  requestRecord(): void;
  onRecordRequest(cb: () => void): () => void;
  /** Resolves once the engine reports Recording (the state event comes first). */
  record(opts: RecordOptions): Promise<void>;
  close(): Promise<void>;
  /** The state now (a window that opens or reloads mid-recording). */
  state(): Promise<RecState>;
  onState(cb: (s: RecState) => void): () => void;
  /** A warning sentence for the error line; the recording continues. */
  onWarning(cb: (text: string) => void): () => void;
  /** The recording stopped on an engine error; the bar returns to the setup with the sentence. */
  onFailed(cb: (text: string) => void): () => void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /** A session preset id ("p1"), or null to zoom out. */
  zoom(presetId: string | null): Promise<void>;
  /** Stop: Rust closes the recorder and opens the project in the main window. */
  stop(): Promise<void>;
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
    fitBar: (w, h, barTop, recording) => invoke<void>("fit_bar", { w, h, barTop, recording }),
    requestRecord: () => void emitTo("bar", "recorder://record").catch(() => undefined),
    onRecordRequest: (cb) => unlistenLater(listen("recorder://record", () => cb())),
    record: (opts) => invoke<void>("start_recording", { opts }),
    close: () => invoke<void>("close_recorder"),
    state: () => invoke<RecState>("recording_state"),
    onState: (cb) => unlistenLater(listen<RecState>("recorder://state", (e) => cb(e.payload))),
    onWarning: (cb) => unlistenLater(listen<string>("recorder://warning", (e) => cb(e.payload))),
    onFailed: (cb) => unlistenLater(listen<string>("recorder://failed", (e) => cb(e.payload))),
    pause: () => invoke<void>("pause_recording"),
    resume: () => invoke<void>("resume_recording"),
    setMuted: (muted) => invoke<void>("set_mic_muted", { muted }),
    zoom: (presetId) => invoke<void>("trigger_zoom", { presetId }),
    stop: () => invoke<string>("stop_recording").then(() => undefined),
  };
}

/** Sample monitor: 1440 x 900 CSS at 200%, so the chip reads the mockup's "1920 x 1080". */
export const FAKE_MONITOR: Monitor = { index: 0, name: "Fake display", x: 0, y: 0, width: 2880, height: 1800, scale: 2 };

/** Fake recording state (`?fake&state=recording`): the mockup's 02:41 with "Cart total" live. */
const FAKE_RECORDING: RecState = { recording: true, paused: false, muted: false, mic: true, activePreset: "p1", recUs: 161_000_000 };

function fakeApi(): RecorderApi {
  const p = params();
  const error = p.get("error");
  const record = new EventTarget();
  let rec: RecState = p.get("state") === "recording" ? FAKE_RECORDING : IDLE;
  const states = new EventTarget();
  const set = async (patch: Partial<RecState>) => {
    rec = { ...rec, ...patch };
    states.dispatchEvent(new Event("state"));
  };
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
      // Setup: -30 dB, half the meter. Recording: -34 dB, 6 of 14 bars, as in the mockups.
      cb(rec.recording ? 0.02 : 0.0316);
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
    state: async () => rec,
    onState: (cb) => {
      const h = () => cb(rec);
      states.addEventListener("state", h);
      return () => states.removeEventListener("state", h);
    },
    onWarning: (cb) => {
      if (error === "warning") cb("Hotkey Ctrl+1 is taken by another app");
      return () => undefined;
    },
    onFailed: () => () => undefined,
    pause: () => set({ paused: true }),
    resume: () => set({ paused: false }),
    setMuted: (muted) => set({ muted }),
    zoom: (presetId) => set({ activePreset: presetId }),
    stop: async () => undefined,
  };
}

let api: RecorderApi | null = null;
export function recorderApi(): RecorderApi {
  api ??= isFake() ? fakeApi() : tauriApi();
  return api;
}
