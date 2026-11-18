import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseEvents, parseProject } from "@marz/format";
import { makeSample } from "./make-sample";

const probe = (file: string, args: string[]) =>
  execFileSync("ffprobe", ["-v", "error", ...args, "-of", "csv=p=0", file]).toString().trim();

test("generates a valid project", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "marz-sample-")), "demo.marz");
  await makeSample(dir, { durationSec: 3 });

  const project = parseProject(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")));
  const { header, events } = parseEvents(readFileSync(join(dir, "events.jsonl"), "utf8"));

  expect(project.durationUs).toBe(3_000_000);
  expect(project.tracks.mic?.offsetUs).toBe(12400);
  expect(header.source).toEqual(project.source);
  expect(events.filter((e) => e.type === "click").length).toBeGreaterThanOrEqual(2);
  expect(events.filter((e) => e.type === "cursor").length).toBeGreaterThanOrEqual(1);

  const vDur = Number(probe(join(dir, "screen.mp4"), ["-show_entries", "format=duration"]));
  expect(Math.abs(vDur - 3)).toBeLessThan(0.2);
  const rate = probe(join(dir, "mic.wav"), ["-select_streams", "a:0", "-show_entries", "stream=sample_rate"]);
  expect(rate).toBe("48000");
}, 60_000);

test("adds a synthetic camera track when asked", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "marz-sample-")), "cam.marz");
  await makeSample(dir, { durationSec: 2, camera: true });
  const project = parseProject(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")));
  expect(project.tracks.camera).toEqual({ file: "camera.mp4", offsetUs: 41_000, width: 1280, height: 720, fps: 30 });
  expect(probe(join(dir, "camera.mp4"), ["-select_streams", "v:0", "-show_entries", "stream=width,height"])).toBe("1280,720");
}, 60_000);
