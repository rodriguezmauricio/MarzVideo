// Recorder setup state: mode, region, zoom presets, mic and cursor. Persisted to localStorage per
// monitor so the last setup comes back. The overlay and the bar are two windows of the same
// origin; each keeps its own store and reloads it when the other one saves (`storage` event).
import { lockAspect } from "@marz/timeline";
import { create } from "zustand";
import { OUTPUT_ASPECT, type NormRect, type PxRect } from "./regionMath";

export type Mode = "full" | "region" | "exact";
export type Preset = { id: string; name: string; rect: NormRect };
/** The monitor the recorder covers. Position and size in physical pixels. */
export type Monitor = { index: number; name: string; x: number; y: number; width: number; height: number; scale: number };

export type Setup = {
  mode: Mode;
  /** Physical pixels relative to the monitor's top-left (what the engine records). */
  region: PxRect;
  /** Region keeps 16:9 while drawing and resizing. */
  locked: boolean;
  /** Normalized to the region (to the monitor in Full screen). */
  presets: Preset[];
  /** Null: the default microphone. */
  micId: string | null;
  cursorHidden: boolean;
  /** Also record the computer's sound (`system.wav`). */
  systemAudio: boolean;
};

export const MAX_PRESETS = 9;
const MODES: Mode[] = ["full", "region", "exact"];

export const setupKey = (m: Monitor) => `marz.recorder.setup.${m.index}.${m.width}x${m.height}`;

export function defaultSetup(m: Monitor): Setup {
  const w = Math.round((m.width * 2) / 3 / 2) * 2;
  const h = Math.round((w * 9) / 16 / 2) * 2;
  return {
    mode: "region",
    region: { x: Math.round((m.width - w) / 2), y: Math.round((m.height - h) / 2), w, h },
    locked: true,
    presets: [],
    micId: null,
    cursorHidden: false,
    systemAudio: false,
  };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRect = (r: unknown): r is PxRect => {
  const o = r as Record<string, unknown> | null;
  return !!o && num(o.x) && num(o.y) && num(o.w) && num(o.h) && o.w >= 0 && o.h >= 0;
};
const isNorm = (r: unknown) => isRect(r) && r.x >= 0 && r.y >= 0 && r.w <= 1 && r.h <= 1;
const isPreset = (p: unknown): p is Preset => {
  const o = p as Record<string, unknown> | null;
  return !!o && typeof o.id === "string" && /^[1-9]$/.test(o.id) && typeof o.name === "string" && isNorm(o.rect);
};

/** The stored setup for monitor `m`, or the default if nothing valid is stored or storage fails. */
export function loadSetup(storage: Storage, m: Monitor): Setup {
  const fallback = defaultSetup(m);
  try {
    const raw = storage.getItem(setupKey(m));
    if (!raw) return fallback;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!MODES.includes(o.mode as Mode) || !isRect(o.region) || !Array.isArray(o.presets)) return fallback;
    if (typeof o.locked !== "boolean" || typeof o.cursorHidden !== "boolean") return fallback;
    if (o.micId !== null && typeof o.micId !== "string") return fallback;
    const r = o.region;
    return {
      mode: o.mode as Mode,
      region: { x: r.x, y: r.y, w: r.w, h: r.h },
      locked: o.locked,
      presets: o.presets
        .filter(isPreset)
        .filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i)
        .slice(0, MAX_PRESETS)
        .map((p) => ({ id: p.id, name: p.name, rect: { x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h } })),
      micId: o.micId as string | null,
      cursorHidden: o.cursorHidden,
      // Missing in setups saved before the option existed: off.
      systemAudio: o.systemAudio === true,
    };
  } catch {
    return fallback;
  }
}

export function saveSetup(storage: Storage, m: Monitor, s: Setup): void {
  try {
    storage.setItem(setupKey(m), JSON.stringify(s));
  } catch {
    // Storage blocked or full: the setup still works, it just does not come back next time.
  }
}

/** Add a preset in the lowest free slot 1..9 ("Zoom n"); unchanged when all 9 are taken. */
export function addPreset(list: Preset[], rect: NormRect): Preset[] {
  for (let n = 1; n <= MAX_PRESETS; n++) {
    const id = String(n);
    if (!list.some((p) => p.id === id)) return [...list, { id, name: `Zoom ${n}`, rect }].sort((a, b) => a.id.localeCompare(b.id));
  }
  return list;
}

/** Safe access to window.localStorage (can throw in locked-down contexts). */
export function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type State = Setup & {
  monitor: Monitor;
  /** Fake mode keeps everything in memory. */
  persist: boolean;
  selected: string | null;
  init: (m: Monitor, initial: Setup, persist: boolean) => void;
  update: (patch: Partial<Setup>) => void;
  reload: () => void;
  select: (id: string | null) => void;
};

const pick = (s: Setup): Setup => ({
  mode: s.mode,
  region: s.region,
  locked: s.locked,
  presets: s.presets,
  micId: s.micId,
  cursorHidden: s.cursorHidden,
  systemAudio: s.systemAudio,
});

export const useRecorder = create<State>((set, get) => ({
  ...defaultSetup({ index: 0, name: "", x: 0, y: 0, width: 1440, height: 900, scale: 1 }),
  monitor: { index: 0, name: "", x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  persist: false,
  selected: null,
  init: (monitor, initial, persist) => set({ monitor, persist, ...initial }),
  update: (patch) => {
    set(patch);
    const s = get();
    const st = s.persist ? localStore() : null;
    if (st) saveSetup(st, s.monitor, pick(s));
  },
  reload: () => {
    const s = get();
    const st = s.persist ? localStore() : null;
    if (st) set(loadSetup(st, s.monitor));
  },
  select: (selected) => set({ selected }),
}));

/** The setup now (read when Record is pressed). */
export const currentSetup = (): Setup => pick(useRecorder.getState());

/** What Record sends to Rust (recording.rs `RecordOptionsDto`). */
export type RecordOptions = { mode: Mode; region: PxRect; micId: string | null; systemAudio: boolean; cursorHidden: boolean; presets: Preset[] };

/** The session preset id for a setup preset ("1" -> "p1"); Ctrl+n zooms into "pn". */
export const sessionPresetId = (id: string) => `p${id}`;

/** The setup as the engine needs it: presets get session ids "p1".."p9" in order, and rects
 * normalized to the region (the monitor in Full screen) and locked to the output aspect, exactly
 * as the overlay draws them. */
export function recordOptions(s: Setup, m: Monitor): RecordOptions {
  const source = s.mode === "full" ? { width: m.width, height: m.height } : { width: s.region.w, height: s.region.h };
  return {
    mode: s.mode,
    region: { x: Math.round(s.region.x), y: Math.round(s.region.y), w: Math.round(s.region.w), h: Math.round(s.region.h) },
    micId: s.micId,
    systemAudio: s.systemAudio,
    cursorHidden: s.cursorHidden,
    presets: [...s.presets]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({ id: sessionPresetId(p.id), name: p.name, rect: lockAspect(p.rect, OUTPUT_ASPECT, source) })),
  };
}
