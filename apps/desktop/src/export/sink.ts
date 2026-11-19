import { audioEdits, TARGET_LUFS, type Project } from "@marz/format";
import { keptSegments, outputDurationUs } from "@marz/timeline";
import type { Codec, ExportPreset } from "./presets";

/** Same JSON as the Rust `ExportJob` in crates/export/src/lib.rs (serde camelCase). */
export interface ExportJobDto {
  projectDir: string;
  outPath: string;
  width: number;
  height: number;
  fps: number;
  segments: { srcStartUs: number; srcEndUs: number; outStartUs: number }[];
  mic: AudioTrackDto | null;
  /** The computer's sound, mixed with the mic. */
  system: AudioTrackDto | null;
  outputDurationUs: number;
  /** Bring the mix to this loudness (absent: leave it as it is). */
  normalize?: { targetLufs: number };
  /** The stream the page sends: H.264 or HEVC annexb. */
  codec: Codec;
}

/** Same JSON as the Rust `MicJob`. Fades are in output time. */
export interface AudioTrackDto {
  file: string;
  offsetUs: number;
  volume: number;
  muted: boolean;
  fadeInUs: number;
  fadeOutUs: number;
  /** Read the noise-cleaned copy `cache/mic.clean.wav` (mic only, set when it was just made). */
  clean: boolean;
}

/** Same fields as the Rust `ExportReport`. */
export interface ExportReport {
  outPath: string;
  durationUs: number;
  sizeBytes: number;
  /** The codec the video was encoded with (set by the page: H.264 when HEVC fell back). */
  codec?: Codec;
}

/** Where the encoded H.264 or HEVC (annexb) goes: FFmpeg through Tauri in the app, memory in tests. */
export interface ExportSink {
  begin(job: ExportJobDto): Promise<void>;
  chunk(data: Uint8Array): Promise<void>;
  finish(): Promise<ExportReport>;
  cancel(): Promise<void>;
}

/** The muxer job for a project and preset. Rust reads whole integers for every time (Math.round). */
export function buildExportJob(opts: { project: Project; preset: ExportPreset; projectDir: string; outPath: string; cleanMic?: boolean }): ExportJobDto {
  const { project, preset } = opts;
  const segs = keptSegments(project.durationUs, project.edits.cuts);
  const mic = project.tracks.mic;
  const sys = project.tracks.system;
  const audio = audioEdits(project);
  type Track = NonNullable<Project["tracks"]["mic"]>;
  const track = (t: Track, fade: { fadeInUs: number; fadeOutUs: number }, clean: boolean): AudioTrackDto => ({
    file: t.file,
    offsetUs: Math.round(t.offsetUs),
    volume: t.volume,
    muted: t.muted,
    fadeInUs: Math.round(fade.fadeInUs),
    fadeOutUs: Math.round(fade.fadeOutUs),
    clean,
  });
  return {
    projectDir: opts.projectDir,
    outPath: opts.outPath,
    width: preset.width,
    height: preset.height,
    fps: preset.fps(project.source.fps),
    segments: segs.map((s) => ({
      srcStartUs: Math.round(s.srcStartUs),
      srcEndUs: Math.round(s.srcEndUs),
      outStartUs: Math.round(s.outStartUs),
    })),
    mic: mic ? track(mic, audio.mic, audio.denoise && !!opts.cleanMic) : null,
    system: sys ? track(sys, audio.system, false) : null,
    outputDurationUs: Math.round(outputDurationUs(segs)),
    ...(audio.normalize ? { normalize: { targetLufs: TARGET_LUFS } } : {}),
    codec: preset.codec,
  };
}
