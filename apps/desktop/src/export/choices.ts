import type { Codec, ExportPreset, ExportPresetId } from "./presets";

/** Landscape sizes. The vertical preset keeps 1080 x 1920. */
export type SizeId = "720p" | "1080p" | "1440p";
export type FpsChoice = 24 | 30 | 60;

/** What the export panel picks for one preset. `fps` null: the preset's own rate. Remembered per preset in
 *  local storage (never in project.json, like the preset itself). */
export interface ExportChoices {
  codec: Codec;
  size: SizeId;
  fps: FpsChoice | null;
}

export const DEFAULT_CHOICES: ExportChoices = { codec: "h264", size: "1080p", fps: null };
export const CODEC_OPTIONS: Codec[] = ["h264", "hevc"];
export const CODEC_LABEL: Record<Codec, string> = { h264: "H.264", hevc: "HEVC" };
export const SIZE_OPTIONS: SizeId[] = ["720p", "1080p", "1440p"];
export const FPS_OPTIONS: FpsChoice[] = [24, 30, 60];

const SIZES: Record<SizeId, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
};

/** The recording's rate as a whole number, 60 at most. */
export function sourceRate(sourceFps: number): number {
  return Math.min(60, Math.max(1, Math.round(sourceFps)));
}

/** A frame rate above the recording's own cannot be picked. */
export function fpsAllowed(fps: FpsChoice, sourceFps: number): boolean {
  return fps <= sourceRate(sourceFps);
}

/** H.264 bitrate (bit/s), YouTube's upload guidance for landscape; HEVC gets 60 percent of it. */
export function bitrateFor(id: ExportPresetId, height: number, fps: number, codec: Codec): number {
  const high = fps > 30;
  let rate: number;
  if (id === "vertical") rate = high ? 9_000_000 : 6_000_000;
  else if (height <= 720) rate = high ? 7_500_000 : 5_000_000;
  else if (height <= 1080) rate = high ? 12_000_000 : 8_000_000;
  else rate = high ? 24_000_000 : 16_000_000;
  return codec === "hevc" ? Math.round(rate * 0.6) : rate;
}

/** The same preset encoded with another codec (the HEVC to H.264 fallback). */
export function withCodec(preset: ExportPreset, codec: Codec): ExportPreset {
  return { ...preset, codec, bitrate: (fps) => bitrateFor(preset.id, preset.height, fps, codec) };
}

/** The preset as this export will run it: size (landscape only), a fixed frame rate, codec and bitrate. */
export function resolvePreset(base: ExportPreset, choices: ExportChoices, sourceFps: number): ExportPreset {
  const fps = choices.fps === null ? base.fps(sourceFps) : Math.min(choices.fps, sourceRate(sourceFps));
  const size = base.id === "vertical" ? { width: base.width, height: base.height } : SIZES[choices.size];
  const frameRect = base.id === "vertical" ? base.frameRect : { x: 0, y: 0, w: size.width, h: size.height };
  return withCodec({ ...base, ...size, frameRect, fps: () => fps }, choices.codec);
}

const key = (id: ExportPresetId) => `marz.export.choices.${id}`;

/** The choices remembered for a preset; anything missing or unknown is the default. Storage may throw. */
export function readChoices(storage: Storage | null | undefined, id: ExportPresetId): ExportChoices {
  try {
    const raw = storage?.getItem(key(id));
    if (!raw) return { ...DEFAULT_CHOICES };
    const v = JSON.parse(raw) as Partial<Record<keyof ExportChoices, unknown>>;
    return {
      codec: CODEC_OPTIONS.includes(v.codec as Codec) ? (v.codec as Codec) : DEFAULT_CHOICES.codec,
      size: SIZE_OPTIONS.includes(v.size as SizeId) ? (v.size as SizeId) : DEFAULT_CHOICES.size,
      fps: FPS_OPTIONS.includes(v.fps as FpsChoice) ? (v.fps as FpsChoice) : null,
    };
  } catch {
    return { ...DEFAULT_CHOICES };
  }
}

export function writeChoices(storage: Storage | null | undefined, id: ExportPresetId, c: ExportChoices): void {
  try {
    storage?.setItem(key(id), JSON.stringify(c));
  } catch {
    // Not remembered.
  }
}
