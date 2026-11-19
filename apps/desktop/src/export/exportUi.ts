import { PRESETS, type ExportPreset, type ExportPresetId } from "./presets";
import { ExportFailure } from "./tauriSink";

const ORDER: ExportPresetId[] = ["youtube", "vertical"];
const LAST_KEY = "marz.export.preset";

/** Sentences exportProject itself throws that can go to the warning bar as they are. */
const KNOWN = ["This computer cannot encode H.264 video", "Nothing left to export. Every part is cut"];
const FALLBACK = "The video could not be encoded";

export type PanelState = { open: boolean; highlight: ExportPresetId };

/** A key in the open preset panel: the next state and, for Enter, the preset to export. Null when the
 *  panel does not use the key (closed, or another key). */
export function panelKey(s: PanelState, key: string): (PanelState & { pick?: ExportPresetId }) | null {
  if (!s.open) return null;
  const i = ORDER.indexOf(s.highlight);
  switch (key) {
    case "ArrowDown":
      return { open: true, highlight: ORDER[(i + 1) % ORDER.length]! };
    case "ArrowUp":
      return { open: true, highlight: ORDER[(i + ORDER.length - 1) % ORDER.length]! };
    case "Enter":
    case "NumpadEnter":
      return { open: false, highlight: s.highlight, pick: s.highlight };
    case "Escape":
      return { open: false, highlight: s.highlight };
    default:
      return null;
  }
}

/** The preset picked last time (YouTube the first time). Storage may be missing or throw. */
export function readLastPreset(storage: Storage | null | undefined): ExportPresetId {
  try {
    const v = storage?.getItem(LAST_KEY);
    return v === "youtube" || v === "vertical" ? v : "youtube";
  } catch {
    return "youtube";
  }
}

const burnKey = (id: ExportPresetId) => `marz.burnCaptions.${id}`;

/** "Burn captions" for a preset: remembered per preset, the preset's default the first time. */
export function readBurn(storage: Storage | null | undefined, id: ExportPresetId, fallback: boolean): boolean {
  try {
    const v = storage?.getItem(burnKey(id));
    return v === "1" ? true : v === "0" ? false : fallback;
  } catch {
    return fallback;
  }
}

export function writeBurn(storage: Storage | null | undefined, id: ExportPresetId, on: boolean): void {
  try {
    storage?.setItem(burnKey(id), on ? "1" : "0");
  } catch {
    // Not remembered.
  }
}

export function writeLastPreset(storage: Storage | null | undefined, id: ExportPresetId): void {
  try {
    storage?.setItem(LAST_KEY, id);
  } catch {
    // Not remembered; the panel opens on YouTube next time.
  }
}

/** "1920 x 1080, 60 fps": the picture and the frame rate this export will use. */
export function presetSize(preset: ExportPreset, sourceFps: number): string {
  return `${preset.width} x ${preset.height}, ${preset.fps(sourceFps)} fps`;
}

/** Whole percent, 0 to 100. */
export function percent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, Math.floor(p * 100)));
}

/** The warning bar sentence for a failed export. */
export function failureText(e: unknown): string {
  let reason = FALLBACK;
  if (e instanceof ExportFailure) reason = e.reason;
  else if (e instanceof Error && KNOWN.includes(e.message.replace(/\.$/, ""))) reason = e.message;
  return `Export failed. ${reason.replace(/\.$/, "")}. Your project is unchanged.`;
}

export const PRESET_ORDER = ORDER.map((id) => PRESETS[id]);
