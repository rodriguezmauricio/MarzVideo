import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseProject, serializeProject, type Project } from "@marz/format";

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
  lines.sort((a, b) => ((a as any).tUs ?? -1) - ((b as any).tUs ?? -1));
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * `syncOffsetMs` switches picture and sound to a sync test: a black screen that flashes white for
 * 100 ms every 3 s (from 3 s on), and a 1 kHz 100 ms beep at the same moments on a quiet bed, the
 * beep arriving `syncOffsetMs` after the flash in recording time. The mic offset is compensated,
 * so `pnpm sync-check` should read exactly that offset.
 */
export async function makeSample(outDir: string, opts: { durationSec?: number; syncOffsetMs?: number } = {}): Promise<void> {
  const durationSec = opts.durationSec ?? 20;
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

  // 440 Hz tone plus a 1.5 kHz beep at the start of every second, so sync is audible.
  // In sync mode the beep starts (syncOffset - micOffset) after the flash, in file time.
  const u = `(t-(${((opts.syncOffsetMs ?? 0) / 1000 - MIC_OFFSET_US / 1_000_000).toFixed(6)}))`;
  const expr = sync
    ? `0.01*sin(2*PI*440*t)+0.6*sin(2*PI*1000*${u})*gte(${u},3)*lt(mod(${u},3),0.1)`
    : "0.1*sin(2*PI*440*t)+0.6*sin(2*PI*1500*t)*lt(mod(t,1),0.05)";
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${durationSec}`,
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
    join(outDir, "mic.wav"),
  ]);

  await writeFile(join(outDir, "events.jsonl"), buildEvents(durationSec));

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
    },
    output: { width: W, height: H, fps: FPS },
    zoomPresets: [],
    edits: { zooms: [], cuts: [], cursor: { hidden: false }, clicks: { effect: "none" } },
  });
  await writeFile(join(outDir, "project.json"), serializeProject(project));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(fileURLToPath(import.meta.url), "../../..");
  const out = process.argv[2] ?? join(root, "samples", "demo.marz");
  makeSample(out).then(() => console.log(`sample written to ${out}`));
}
