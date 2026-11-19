import { PRESETS, type Codec, type ExportPreset, type ExportPresetId } from "./presets";
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
  return `${preset.width} x ${preset.height}, ${preset.fps(sourceFps)} fps${preset.codec === "hevc" ? ", HEVC" : ""}`;
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

/** The last part of a folder path, for the panel and the done line ("D:\MarzOS\Inbox" is "Inbox"). */
export function folderName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** The done line's note after "Also copy to". */
export function copyNote(dir: string, ok: boolean): string {
  return ok ? `Copied to ${folderName(dir)}.` : `Could not copy to ${folderName(dir)}.`;
}

/** The line under the Codec row when HEVC cannot be used, or null. `general`: HEVC at all (1080p, 30 fps);
 *  `here`: HEVC at this export's size and frame rate (undefined: not asked yet). */
export function hevcNote(general: "unknown" | "yes" | "no", here: boolean | undefined): string | null {
  if (general === "no") return "HEVC is not available on this computer. Exports use H.264.";
  if (here === false) return "HEVC is not available at this size and frame rate. This export uses H.264.";
  return null;
}

/** The done line's first words: says so when HEVC fell back to H.264. */
export function doneLead(picked: Codec, used: Codec): string {
  return picked === "hevc" && used !== "hevc" ? "Exported as H.264. HEVC is not available." : "Exported.";
}
