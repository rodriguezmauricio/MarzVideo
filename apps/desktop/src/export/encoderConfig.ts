import type { ExportPreset } from "./presets";

/** H.264 High 4.0, annexb so FFmpeg can read it as a raw `-f h264` stream. */
export function encoderConfig(preset: ExportPreset, fps: number): VideoEncoderConfig {
  return {
    codec: "avc1.640028",
    avc: { format: "annexb" },
    width: preset.width,
    height: preset.height,
    framerate: fps,
    bitrate: preset.bitrate(fps),
    bitrateMode: "variable",
    hardwareAcceleration: "prefer-hardware",
  };
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
