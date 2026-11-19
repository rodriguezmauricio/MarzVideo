import { describe, expect, it } from "vitest";
import type { Project } from "@marz/format";
import { buildExportJob } from "./sink";
import { PRESETS } from "./presets";

const project = {
  version: 1,
  id: "p1",
  name: "Demo",
  createdAt: "2026-11-17T10:00:00Z",
  durationUs: 2_000_000,
  source: { width: 2560, height: 1440, fps: 60 },
  tracks: {
    screen: { file: "screen.mp4", offsetUs: 0 },
    mic: { file: "mic.wav", offsetUs: 12_400, volume: 0.8, muted: false },
  },
  output: { width: 1920, height: 1080, fps: 60 },
  zoomPresets: [],
  edits: {
    zooms: [],
    cuts: [{ id: "c1", startUs: 500_000, endUs: 1_500_000 }],
    cursor: { hidden: false },
    clicks: { effect: "none" },
  },
} as unknown as Project;

describe("buildExportJob", () => {
  it("serializes to the JSON the Rust ExportJob reads (camelCase field names)", () => {
    const job = buildExportJob({ project, preset: PRESETS.youtube, projectDir: "C:\\p\\Demo.marz", outPath: "C:\\out\\Demo.mp4" });
    expect(JSON.parse(JSON.stringify(job))).toEqual({
      projectDir: "C:\\p\\Demo.marz",
      outPath: "C:\\out\\Demo.mp4",
      width: 1920,
      height: 1080,
      fps: 60,
      segments: [
        { srcStartUs: 0, srcEndUs: 500_000, outStartUs: 0 },
        { srcStartUs: 1_500_000, srcEndUs: 2_000_000, outStartUs: 500_000 },
      ],
      mic: { file: "mic.wav", offsetUs: 12_400, volume: 0.8, muted: false, fadeInUs: 0, fadeOutUs: 0, clean: false },
      system: null,
      outputDurationUs: 1_000_000,
      normalize: { targetLufs: -14 },
      codec: "h264",
    });
  });

  it("names the codec FFmpeg reads", () => {
    const job = buildExportJob({ project, preset: { ...PRESETS.youtube, codec: "hevc" }, projectDir: "p", outPath: "o.mp4" });
    expect(job.codec).toBe("hevc");
  });

  it("passes fades, the cleaned mic and the loudness switch from edits.audio", () => {
    const withAudio = {
      ...project,
      tracks: { ...project.tracks, system: { file: "system.wav", offsetUs: 0, volume: 0.5, muted: false } },
      edits: { ...project.edits, audio: { normalize: false, mic: { fadeInUs: 500_000, fadeOutUs: 1_000_000 }, system: { fadeInUs: 2_000_000 } } },
    } as Project;
    const job = buildExportJob({ project: withAudio, preset: PRESETS.youtube, projectDir: "p", outPath: "o.mp4", cleanMic: true });
    expect(job.mic).toMatchObject({ fadeInUs: 500_000, fadeOutUs: 1_000_000, clean: true });
    expect(job.system).toMatchObject({ volume: 0.5, fadeInUs: 2_000_000, fadeOutUs: 0, clean: false });
    expect(job.normalize).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("normalize");
  });

  it("never reads the cleaned copy when noise removal is off", () => {
    const off = { ...project, edits: { ...project.edits, audio: { denoise: false } } } as Project;
    expect(buildExportJob({ project: off, preset: PRESETS.youtube, projectDir: "p", outPath: "o", cleanMic: true }).mic?.clean).toBe(false);
  });

  it("passes the computer sound track when the project has one", () => {
    const withSys = { ...project, tracks: { ...project.tracks, system: { file: "system.wav", offsetUs: 0, volume: 1, muted: false } } } as Project;
    const job = buildExportJob({ project: withSys, preset: PRESETS.youtube, projectDir: "p", outPath: "o.mp4" });
    expect(job.system).toEqual({ file: "system.wav", offsetUs: 0, volume: 1, muted: false, fadeInUs: 0, fadeOutUs: 0, clean: false });
  });

  it("uses the preset size and fps, and null when there is no mic", () => {
    const noMic = { ...project, tracks: { screen: project.tracks.screen } } as Project;
    const job = buildExportJob({ project: noMic, preset: PRESETS.vertical, projectDir: "d", outPath: "o" });
    expect([job.width, job.height, job.fps]).toEqual([1080, 1920, 30]);
    expect(job.mic).toBeNull();
    expect(JSON.stringify(job)).toContain('"mic":null');
  });
});
