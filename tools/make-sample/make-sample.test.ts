import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseEvents, parseProject, parseTranscript } from "@marz/format";
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
  expect(events.filter((e) => e.type === "draw" && e.op === "add").length).toBe(6);
  expect(events.filter((e) => e.type === "cursorShape").map((e) => (e as { shape: string }).shape)).toContain("hand");

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

test("writes a transcript that parses and fits the duration", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "marz-sample-")), "talk.marz");
  await makeSample(dir, { durationSec: 30 });
  const t = parseTranscript(JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")));
  expect(t.words.length).toBeGreaterThanOrEqual(40);
  expect(t.words.at(-1)!.endUs).toBeLessThanOrEqual(30_000_000);
  expect(t.sections.map((s) => s.language)).toEqual(["pt", "en"]);
  const texts = t.words.map((w) => w.text);
  for (const w of ["umm", "é", "Tipo,", "uh"]) expect(texts).toContain(w);
  const gaps = t.words.slice(1).map((w, i) => w.startUs - t.words[i]!.endUs);
  expect(Math.max(...gaps)).toBeGreaterThanOrEqual(2_000_000);
  const st = statSync(join(dir, "mic.wav"));
  expect(t.mic.bytes).toBe(st.size);
}, 60_000);
