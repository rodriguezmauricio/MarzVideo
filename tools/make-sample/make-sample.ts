import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseProject, serializeProject, serializeTranscript, type Project } from "@marz/format";
import { sampleTranscript, speechWav } from "./sampleSpeech";

const run = promisify(execFile);

const W = 1920;
const H = 1080;
const FPS = 30;
const MIC_OFFSET_US = 12400;

function buildEvents(durationSec: number): string {
  const frameUs = Math.round(1_000_000 / FPS);
  const durUs = durationSec * 1_000_000;
  const lines: object[] = [
    { type: "header", version: 1, source: { width: W, height: H, fps: FPS }, startedAt: new Date().toISOString() },
  ];

  // Cursor glides between three screen areas, one sample per frame when it moved.
  const stops = [
    { x: 300, y: 250 },
    { x: 1450, y: 700 },
    { x: 900, y: 900 },
  ];
  let last = { x: -1, y: -1 };
  for (let t = frameUs; t < durUs; t += frameUs) {
    const p = (t / durUs) * (stops.length - 1);
    const i = Math.min(Math.floor(p), stops.length - 2);
    const f = p - i;
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const x = Math.round(a.x + (b.x - a.x) * f);
    const y = Math.round(a.y + (b.y - a.y) * f);
    if (x !== last.x || y !== last.y) {
      lines.push({ tUs: t, type: "cursor", x, y });
      last = { x, y };
    }
  }

  // Two click clusters, one near the first stop and one near the second.
  const clusters = [
    { startUs: Math.round(durUs * 0.2), x: 330, y: 270 },
    { startUs: Math.round(durUs * 0.6), x: 1420, y: 690 },
  ];
  for (const c of clusters) {
    for (let k = 0; k < 3; k++) {
      const down = c.startUs + k * 300_000;
      const x = c.x + k * 12;
      const y = c.y + k * 8;
      lines.push({ tUs: down, type: "click", button: "left", state: "down", x, y });
      lines.push({ tUs: down + 80_000, type: "click", button: "left", state: "up", x, y });
    }
  }
  // Cursor shapes as Windows reports them: arrow, a hand over each click cluster, a text beam near the end.
  lines.push({ tUs: 0, type: "cursorShape", shape: "arrow", px: 32 });
  for (const c of clusters) {
    lines.push({ tUs: c.startUs - 200_000, type: "cursorShape", shape: "hand", px: 32 });
    lines.push({ tUs: c.startUs + 1_000_000, type: "cursorShape", shape: "arrow", px: 32 });
  }
  lines.push({ tUs: Math.round(durUs * 0.85), type: "cursorShape", shape: "ibeam", px: 32 });
  // Live drawing (draw mode while recording): a pen loop and a text note near the first clicks,
  // cleared; then an arrow, a rectangle, an ellipse and a highlighter line near the second.
  const at = (f: number) => Math.round(durUs * f);
  const loop = Array.from({ length: 25 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return [Math.round(345 + 90 * Math.cos(a)), Math.round(280 + 55 * Math.sin(a))];
  });
  const draws: [number, string, number, object][] = [
    [0.24, "s1", 0.22, { tool: "pen", color: "accent", width: 6, points: loop }],
    [0.27, "s2", 0.26, { tool: "text", color: "paper", width: 6, points: [[460, 200]], text: "Click here" }],
    [0.62, "s3", 0.61, { tool: "arrow", color: "rec", width: 6, points: [[1100, 520], [1390, 670]] }],
    [0.64, "s4", 0.63, { tool: "rect", color: "accent", width: 6, points: [[1350, 640], [1520, 760]] }],
    [0.67, "s5", 0.66, { tool: "ellipse", color: "paper", width: 6, points: [[820, 840], [1000, 960]] }],
    [0.7, "s6", 0.69, { tool: "highlighter", color: "accent", width: 6, points: [[300, 980], [700, 980]] }],
  ];
  for (const [t, id, start, stroke] of draws) lines.push({ tUs: at(t), type: "draw", op: "add", id, startUs: at(start), stroke });
  lines.push({ tUs: at(0.45), type: "draw", op: "clear" });
  lines.push({ tUs: at(0.75), type: "draw", op: "remove", id: "s6" });
  lines.push({ tUs: at(0.85), type: "draw", op: "clear" });
  lines.sort((a, b) => ((a as any).tUs ?? -1) - ((b as any).tUs ?? -1));
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * `syncOffsetMs` switches picture and sound to a sync test: a black screen that flashes white for
 * 100 ms every 3 s (from 3 s on), and a 1 kHz 100 ms beep at the same moments on a quiet bed, the
 * beep arriving `syncOffsetMs` after the flash in recording time. The mic offset is compensated,
 * so `pnpm sync-check` should read exactly that offset.
 */
/** The synthetic camera's first frame on the recording clock (like a real take's `offsetUs`). */
export const CAMERA_OFFSET_US = 41_000;

/** `camera` adds a synthetic 1280 x 720 30 fps `camera.mp4` (a moving test pattern) as `tracks.camera`. */
export async function makeSample(outDir: string, opts: { durationSec?: number; syncOffsetMs?: number; camera?: boolean } = {}): Promise<void> {
  const durationSec = opts.durationSec ?? 30;
  const sync = opts.syncOffsetMs !== undefined;
  await mkdir(outDir, { recursive: true });

  const videoSource = sync
    ? `color=c=black:size=${W}x${H}:rate=${FPS}:duration=${durationSec},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,3)*lt(mod(t,3),0.1)'`
    : `testsrc=size=${W}x${H}:rate=${FPS}:duration=${durationSec}`;
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", videoSource,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", String(FPS), "-r", String(FPS),
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    join(outDir, "screen.mp4"),
  ]);

  const durationUs = durationSec * 1_000_000;
  if (sync) {
    // A quiet 440 Hz bed and a 1 kHz beep (syncOffset - micOffset) after each flash, in file time.
    const u = `(t-(${((opts.syncOffsetMs ?? 0) / 1000 - MIC_OFFSET_US / 1_000_000).toFixed(6)}))`;
    const expr = `0.01*sin(2*PI*440*t)+0.6*sin(2*PI*1000*${u})*gte(${u},3)*lt(mod(${u},3),0.1)`;
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${durationSec}`,
      "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
      join(outDir, "mic.wav"),
    ]);
  } else {
    // A scripted take: voiced tones where the sample transcript has words, near silence elsewhere.
    const words = sampleTranscript(durationUs, { bytes: 0, modifiedAt: "" }).words;
    await writeFile(join(outDir, "mic.wav"), speechWav(durationUs, words, MIC_OFFSET_US));
    const st = await stat(join(outDir, "mic.wav"));
    const transcript = sampleTranscript(durationUs, { bytes: st.size, modifiedAt: st.mtime.toISOString() });
    await writeFile(join(outDir, "transcript.json"), serializeTranscript(transcript));
  }

  await writeFile(join(outDir, "events.jsonl"), buildEvents(durationSec));

  if (opts.camera) {
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${durationSec - CAMERA_OFFSET_US / 1e6}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "30", "-r", "30",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      join(outDir, "camera.mp4"),
    ]);
  }

  const project: Project = parseProject({
    version: 1,
    id: crypto.randomUUID(),
    name: "Demo recording",
    createdAt: new Date().toISOString(),
    durationUs: durationSec * 1_000_000,
    source: { width: W, height: H, fps: FPS },
    tracks: {
      screen: { file: "screen.mp4", offsetUs: 0 },
      mic: { file: "mic.wav", offsetUs: MIC_OFFSET_US, volume: 1, muted: false },
      ...(opts.camera ? { camera: { file: "camera.mp4", offsetUs: CAMERA_OFFSET_US, width: 1280, height: 720, fps: 30 } } : {}),
    },
    output: { width: W, height: H, fps: FPS },
    zoomPresets: [],
    edits: { zooms: [], cuts: [], cursor: { hidden: false }, clicks: { effect: "none" } },
  });
  await writeFile(join(outDir, "project.json"), serializeProject(project));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(fileURLToPath(import.meta.url), "../../..");
  const camera = process.argv.includes("--camera");
  const out = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(root, "samples", camera ? "demo-camera.marz" : "demo.marz");
  makeSample(out, { camera }).then(() => console.log(`sample written to ${out}`));
}
