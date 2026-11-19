import { withCodec } from "./choices";
import type { Codec, ExportPreset } from "./presets";

/** More pixels than 1920 x 1080 needs the higher level. */
const big = (p: ExportPreset) => p.width * p.height > 1920 * 1080;

/** H.264 High (level 4.0, 5.1 above 1080p) or HEVC Main (4.1, 5.1 above 1080p), annexb so FFmpeg can
 *  read it as a raw `-f h264` / `-f hevc` stream. */
export function encoderConfig(preset: ExportPreset, fps: number): VideoEncoderConfig {
  const base = {
    width: preset.width,
    height: preset.height,
    framerate: fps,
    bitrate: preset.bitrate(fps),
    bitrateMode: "variable" as const,
    hardwareAcceleration: "prefer-hardware" as const,
  };
  if (preset.codec === "hevc") return { codec: big(preset) ? "hvc1.1.6.L153.B0" : "hvc1.1.6.L123.B0", hevc: { format: "annexb" }, ...base } as VideoEncoderConfig;
  return { codec: big(preset) ? "avc1.640033" : "avc1.640028", avc: { format: "annexb" }, ...base };
}

/** The hardware encoder when the computer has one, else whatever the browser offers
 *  ("no-preference"). Null when neither is supported. */
export async function pickEncoderConfig(
  preset: ExportPreset,
  fps: number,
  isSupported: (config: VideoEncoderConfig) => Promise<boolean>,
): Promise<VideoEncoderConfig | null> {
  const hardware = encoderConfig(preset, fps);
  if (await isSupported(hardware)) return hardware;
  const any: VideoEncoderConfig = { ...hardware, hardwareAcceleration: "no-preference" };
  return (await isSupported(any)) ? any : null;
}

/** The preset's codec, or H.264 when HEVC cannot be encoded here. Says which codec it got. */
export async function pickCodecConfig(
  preset: ExportPreset,
  fps: number,
  isSupported: (config: VideoEncoderConfig) => Promise<boolean>,
): Promise<{ config: VideoEncoderConfig; codec: Codec } | null> {
  const first = await pickEncoderConfig(preset, fps, isSupported);
  if (first) return { config: first, codec: preset.codec };
  if (preset.codec !== "hevc") return null;
  const h264 = await pickEncoderConfig(withCodec(preset, "h264"), fps, isSupported);
  return h264 ? { config: h264, codec: "h264" } : null;
}

/** Can this computer encode HEVC at this size and frame rate (any encoder)? For the export panel. */
export async function hevcSupportedAt(
  size: { width: number; height: number },
  fps: number,
  isSupported: (config: VideoEncoderConfig) => Promise<boolean>,
): Promise<boolean> {
  const probe: ExportPreset = {
    id: "youtube",
    label: "",
    width: size.width,
    height: size.height,
    fps: () => fps,
    bitrate: () => 4_800_000,
    keyframeEverySec: 1,
    frameRect: { x: 0, y: 0, w: size.width, h: size.height },
    burnCaptionsDefault: false,
    codec: "hevc",
  };
  return (await pickEncoderConfig(probe, fps, isSupported)) !== null;
}

/** Can this computer encode HEVC at all (1080p, 30 fps)? */
export function hevcAvailable(isSupported: (config: VideoEncoderConfig) => Promise<boolean>): Promise<boolean> {
  return hevcSupportedAt({ width: 1920, height: 1080 }, 30, isSupported);
}

/** The key the panel keeps HEVC answers under. */
export const hevcKey = (p: { width: number; height: number }, fps: number) => `${p.width}x${p.height}@${fps}`;
