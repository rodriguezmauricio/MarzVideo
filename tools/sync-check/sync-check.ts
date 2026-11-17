/**
 * Audio/video sync check.
 *
 *   pnpm sync-check <folder.marz | file.mp4> [--mode flash|click] [--latency-ms N]
 *
 * A project: luma per frame from screen.mp4, audio from mic.wav, both shifted by their offsetUs.
 * An MP4: picture and sound from the file. Flash mode (default when the run was made with
 * `marz-capture record ... --sync-probe`) pairs each white flash with the next beep. Click mode
 * pairs `click` `down` events with sound onsets. `sync-probe.json` in the project folder holds
 * the render latency WASAPI reported.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseEvents, parseProject } from "@marz/format";
import {
  type Summary,
  type Verdict,
  detectFlashes,
  detectOnsets,
  judgeClicks,
  judgeFlash,
  meanAbsMs,
  pairNearest,
  summarize,
} from "./detect";

const run = promisify(execFile);
const AUDIO_RATE = 48_000;
/** A flash and its beep are never more than this far apart in a working setup. */
const FLASH_PAIR_GAP_US = 500_000;
/** A click event and its sound. */
const CLICK_PAIR_GAP_US = 100_000;
const CLICK_MIN_GAP_MS = 150;

export type Mode = "flash" | "click";

export type Analysis = {
  flashes: number;
  beeps: number;
  flash: Summary;
  flashMeanAbsMs: number;
  clickEvents: number;
  clickSounds: number;
  click: Summary;
  latencyMs: number | null;
  mode: Mode;
  verdict: Verdict;
};

const ffmpegBytes = async (args: string[]): Promise<Buffer> => {
  const { stdout } = await run("ffmpeg", ["-v", "error", ...args], { encoding: "buffer", maxBuffer: 1 << 30 });
  return stdout;
};

/** Mean luma (0..255) of every frame. */
export async function readLuma(file: string): Promise<Uint8Array> {
  const buf = await ffmpegBytes(["-i", file, "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"]);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Mono 48 kHz signed 16-bit samples; one path for mic.wav and for an MP4's audio. */
export async function readAudio(file: string): Promise<Int16Array> {
  const buf = await ffmpegBytes(["-i", file, "-f", "s16le", "-ac", "1", "-ar", String(AUDIO_RATE), "-"]);
  const even = buf.byteLength - (buf.byteLength % 2);
  const copy = new Uint8Array(even);
  copy.set(buf.subarray(0, even));
  return new Int16Array(copy.buffer);
}

async function videoFps(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", file]);
  const [n, d] = stdout.trim().split("/").map(Number);
  if (!n || !d) throw new Error(`could not read the frame rate of ${file}`);
  return n / d;
}

function readLatency(dir: string): number | null {
  const f = join(dir, "sync-probe.json");
  if (!existsSync(f)) return null;
  const v = JSON.parse(readFileSync(f, "utf8")) as { renderLatencyMs?: unknown };
  return typeof v.renderLatencyMs === "number" ? v.renderLatencyMs : null;
}

function finish(mode: Mode, flashUs: number[], beepUs: number[], clickUs: number[], soundUs: number[], latencyMs: number | null): Analysis {
  const flashDeltas = pairNearest(flashUs, beepUs, FLASH_PAIR_GAP_US);
  const flash = summarize(flashDeltas);
  const flashMeanAbsMs = meanAbsMs(flashDeltas);
  const clickDeltas = pairNearest(clickUs, soundUs, CLICK_PAIR_GAP_US);
  const click = summarize(clickDeltas);
  const verdict = mode === "flash" ? judgeFlash(flash, flashMeanAbsMs, latencyMs) : judgeClicks(click, meanAbsMs(clickDeltas));
  return {
    flashes: flashUs.length,
    beeps: beepUs.length,
    flash,
    flashMeanAbsMs,
    clickEvents: clickUs.length,
    clickSounds: soundUs.length,
    click,
    latencyMs,
    mode,
    verdict,
  };
}

/** Analyse a `.marz` folder. Mode defaults to flash when a probe wrote `sync-probe.json`, else click. */
export async function analyzeProject(dir: string, opts: { mode?: Mode; latencyMs?: number } = {}): Promise<Analysis> {
  const project = parseProject(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")));
  const latencyMs = opts.latencyMs ?? readLatency(dir);
  const mode = opts.mode ?? (latencyMs !== null ? "flash" : "click");
  const screenOffset = project.tracks.screen.offsetUs;
  const flashUs = detectFlashes(await readLuma(join(dir, project.tracks.screen.file)), project.source.fps).map((t) => t + screenOffset);

  let beepUs: number[] = [];
  let soundUs: number[] = [];
  const mic = project.tracks.mic;
  if (mic) {
    const samples = await readAudio(join(dir, mic.file));
    beepUs = detectOnsets(samples, AUDIO_RATE).map((t) => t + mic.offsetUs);
    soundUs = detectOnsets(samples, AUDIO_RATE, CLICK_MIN_GAP_MS).map((t) => t + mic.offsetUs);
  }
  let clickUs: number[] = [];
  const eventsFile = join(dir, "events.jsonl");
  if (existsSync(eventsFile)) {
    const { events } = parseEvents(readFileSync(eventsFile, "utf8"));
    clickUs = events.flatMap((e) => (e.type === "click" && e.state === "down" ? [e.tUs] : []));
  }
  return finish(mode, flashUs, beepUs, clickUs, soundUs, latencyMs);
}

/** Analyse one MP4 (picture and sound from the file). Flash mode only: there are no events. */
export async function analyzeMp4(file: string, opts: { latencyMs?: number } = {}): Promise<Analysis> {
  const fps = await videoFps(file);
  const flashUs = detectFlashes(await readLuma(file), fps);
  const audio = await readAudio(file).catch(() => {
    throw new Error(`${file} has no audio stream to check`);
  });
  const beepUs = detectOnsets(audio, AUDIO_RATE);
  return finish("flash", flashUs, beepUs, [], [], opts.latencyMs ?? null);
}

export function report(a: Analysis): string {
  const row = (s: Summary) =>
    `${s.count} pairs  mean ${s.meanMs.toFixed(1)} ms  min ${s.minMs.toFixed(1)}  max ${s.maxMs.toFixed(1)}  spread ${s.spreadMs.toFixed(1)} ms`;
  const out = [
    `flashes found: ${a.flashes}   beeps found: ${a.beeps}`,
    `flash to beep (beep minus flash): ${row(a.flash)}  mean absolute ${a.flashMeanAbsMs.toFixed(1)} ms`,
    `click events: ${a.clickEvents}   sound onsets: ${a.clickSounds}`,
    `click to sound (sound minus click): ${row(a.click)}`,
    `render latency WASAPI reported: ${a.latencyMs === null ? "unknown" : `${a.latencyMs.toFixed(1)} ms`}`,
    `mode: ${a.mode}`,
    ...a.verdict.lines,
    a.verdict.pass ? "PASS" : "FAIL",
  ];
  return out.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const rest = [...argv];
  let mode: Mode | undefined;
  let latencyMs: number | undefined;
  let target: string | undefined;
  while (rest.length) {
    const a = rest.shift()!;
    if (a === "--mode") {
      const v = rest.shift();
      if (v !== "flash" && v !== "click") throw new Error("--mode needs flash or click");
      mode = v;
    } else if (a === "--latency-ms") {
      latencyMs = Number(rest.shift());
      if (!Number.isFinite(latencyMs)) throw new Error("--latency-ms needs a number");
    } else if (target === undefined) {
      target = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (!target) throw new Error("usage: pnpm sync-check <folder.marz | file.mp4> [--mode flash|click] [--latency-ms N]");
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), target);
  const analysis = statSync(path).isDirectory() ? await analyzeProject(path, { mode, latencyMs }) : await analyzeMp4(path, { latencyMs });
  console.log(report(analysis));
  return analysis.verdict.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
