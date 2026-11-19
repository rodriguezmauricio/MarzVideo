export type ExportPresetId = "youtube" | "vertical";

/** The video codec WebCodecs encodes to (H.264 default; HEVC when the computer can). */
export type Codec = "h264" | "hevc";

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  width: number;
  height: number;
  /** Output frame rate for a source recorded at `sourceFps`. */
  fps(sourceFps: number): number;
  /** Target VBR bitrate in bit/s at output frame rate `fps`. */
  bitrate(fps: number): number;
  keyframeEverySec: 1;
  /** Where the 16:9 editor frame goes on the encoded picture; the rest is ink. */
  frameRect: { x: number; y: number; w: number; h: number };
  /** Whether "Burn captions" starts on for this preset. */
  burnCaptionsDefault: boolean;
  codec: Codec;
}

/** The two export choices. The preset never changes `project.output` or the format. */
export const PRESETS: Record<ExportPresetId, ExportPreset> = {
  youtube: {
    id: "youtube",
    label: "YouTube",
    width: 1920,
    height: 1080,
    fps: (sourceFps) => Math.min(60, Math.max(1, Math.round(sourceFps))),
    bitrate: (fps) => (fps > 30 ? 12_000_000 : 8_000_000),
    keyframeEverySec: 1,
    frameRect: { x: 0, y: 0, w: 1920, h: 1080 },
    burnCaptionsDefault: false,
    codec: "h264",
  },
  vertical: {
    id: "vertical",
    label: "Instagram and TikTok",
    width: 1080,
    height: 1920,
    fps: () => 30,
    bitrate: () => 6_000_000,
    keyframeEverySec: 1,
    // 16:9 scaled to the full width (1080 x 608), centered vertically: (1920 - 608) / 2 = 656.
    frameRect: { x: 0, y: 656, w: 1080, h: 608 },
    burnCaptionsDefault: true,
    codec: "h264",
  },
};
