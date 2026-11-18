import type { Project } from "@marz/format";
import { keptSegments, outputDurationUs } from "@marz/timeline";
import type { ExportPreset } from "./presets";

/** Same JSON as the Rust `ExportJob` in crates/export/src/lib.rs (serde camelCase). */
export interface ExportJobDto {
  projectDir: string;
  outPath: string;
  width: number;
  height: number;
  fps: number;
  segments: { srcStartUs: number; srcEndUs: number; outStartUs: number }[];
  mic: { file: string; offsetUs: number; volume: number; muted: boolean } | null;
  outputDurationUs: number;
}

/** Same fields as the Rust `ExportReport`. */
export interface ExportReport {
  outPath: string;
  durationUs: number;
  sizeBytes: number;
}

/** Where the encoded H.264 (annexb) goes: FFmpeg through Tauri in the app, memory in tests. */
export interface ExportSink {
  begin(job: ExportJobDto): Promise<void>;
  chunk(data: Uint8Array): Promise<void>;
  finish(): Promise<ExportReport>;
  cancel(): Promise<void>;
}

/** The muxer job for a project and preset. Rust reads whole integers for every time (Math.round). */
export function buildExportJob(opts: { project: Project; preset: ExportPreset; projectDir: string; outPath: string }): ExportJobDto {
  const { project, preset } = opts;
  const segs = keptSegments(project.durationUs, project.edits.cuts);
  const mic = project.tracks.mic;
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
    mic: mic ? { file: mic.file, offsetUs: Math.round(mic.offsetUs), volume: mic.volume, muted: mic.muted } : null,
    outputDurationUs: Math.round(outputDurationUs(segs)),
  };
}
