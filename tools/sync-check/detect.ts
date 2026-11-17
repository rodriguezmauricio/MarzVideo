/** Pure detection and verdict code for the audio/video sync check. No file or process access. */

export type Summary = { count: number; meanMs: number; minMs: number; maxMs: number; spreadMs: number };

/** Mean luma below this is "dark", above `BRIGHT` is "lit". */
const DARK = 40;
const BRIGHT = 200;

/**
 * Time in us of each frame where the mean luma jumps from below 40 to above 200. A frame in
 * between (a half-lit transition) keeps the "was dark" state, so the flash fires once, on the
 * first lit frame.
 */
export function detectFlashes(luma: Uint8Array, fps: number): number[] {
  const out: number[] = [];
  let wasDark = false;
  for (let i = 0; i < luma.length; i++) {
    const v = luma[i]!;
    if (v < DARK) {
      wasDark = true;
    } else if (v > BRIGHT) {
      if (wasDark) out.push(Math.round((i * 1_000_000) / fps));
      wasDark = false;
    }
  }
  return out;
}

const WINDOW_MS = 2;
const HISTORY_MS = 200;
const RATIO = 8;
const MIN_HISTORY_WINDOWS = 25;

function median(values: Float64Array, from: number, to: number): number {
  const part = Array.from(values.subarray(from, to)).sort((a, b) => a - b);
  const n = part.length;
  return n % 2 ? part[(n - 1) / 2]! : (part[n / 2 - 1]! + part[n / 2]!) / 2;
}

/**
 * Time in us where a 2 ms RMS window first exceeds 8 times the median RMS of the preceding
 * 200 ms, then one onset per `minGapMs`. The time is refined to the first loud sample around the
 * window, so it is not limited to the 2 ms window grid. Digital silence counts as an RMS of 1.
 */
export function detectOnsets(samples: Int16Array, rate: number, minGapMs = 500): number[] {
  const win = Math.max(1, Math.round((rate * WINDOW_MS) / 1000));
  const history = Math.round(HISTORY_MS / WINDOW_MS);
  const nWin = Math.floor(samples.length / win);
  const rms = new Float64Array(nWin);
  for (let k = 0; k < nWin; k++) {
    let sum = 0;
    for (let i = k * win; i < (k + 1) * win; i++) sum += samples[i]! * samples[i]!;
    rms[k] = Math.sqrt(sum / win);
  }
  const out: number[] = [];
  let lastUs = -Infinity;
  for (let k = MIN_HISTORY_WINDOWS; k < nWin; k++) {
    const ref = Math.max(1, median(rms, Math.max(0, k - history), k));
    if (rms[k]! <= RATIO * ref) continue;
    let first = k * win;
    for (let i = (k - 1) * win; i < (k + 1) * win; i++) {
      if (Math.abs(samples[i]!) > 6 * ref) {
        first = i;
        break;
      }
    }
    const us = Math.round((first * 1_000_000) / rate);
    if (us - lastUs >= minGapMs * 1000) {
      out.push(us);
      lastUs = us;
    }
  }
  return out;
}

/** For each value in `a`, the nearest value in `b` within `maxGapUs`; returns `b - a` for each pair. */
export function pairNearest(a: number[], b: number[], maxGapUs: number): number[] {
  const out: number[] = [];
  for (const x of a) {
    let best: number | undefined;
    for (const y of b) {
      if (Math.abs(y - x) <= maxGapUs && (best === undefined || Math.abs(y - x) < Math.abs(best - x))) best = y;
    }
    if (best !== undefined) out.push(best - x);
  }
  return out;
}

export function summarize(deltasUs: number[]): Summary {
  if (deltasUs.length === 0) return { count: 0, meanMs: 0, minMs: 0, maxMs: 0, spreadMs: 0 };
  const ms = deltasUs.map((d) => d / 1000);
  const min = Math.min(...ms);
  const max = Math.max(...ms);
  return { count: ms.length, meanMs: ms.reduce((s, v) => s + v, 0) / ms.length, minMs: min, maxMs: max, spreadMs: max - min };
}

export function meanAbsMs(deltasUs: number[]): number {
  return deltasUs.length === 0 ? 0 : deltasUs.reduce((s, d) => s + Math.abs(d), 0) / deltasUs.length / 1000;
}

export type Verdict = { pass: boolean; lines: string[] };

export const FLASH_MIN_PAIRS = 20;
export const FLASH_MAX_SPREAD_MS = 17;
export const FLASH_MAX_MEAN_ABS_MS = 45;
export const FLASH_LATENCY_TOLERANCE_MS = 10;
export const CLICK_MAX_MEAN_ABS_MS = 20;
export const CLICK_MIN_PAIRS = 8;

const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");

/** Flash-to-beep criteria: 20 pairs, spread at most 17 ms, mean absolute offset at most 45 ms, mean within 10 ms of the render latency. */
export function judgeFlash(s: Summary, meanAbsOffsetMs: number, renderLatencyMs: number | null): Verdict {
  const checks: { ok: boolean; line: string }[] = [
    { ok: s.count >= FLASH_MIN_PAIRS, line: `pairs: ${s.count} (need ${FLASH_MIN_PAIRS})` },
    { ok: s.spreadMs <= FLASH_MAX_SPREAD_MS, line: `spread: ${s.spreadMs.toFixed(1)} ms (at most ${FLASH_MAX_SPREAD_MS})` },
    { ok: meanAbsOffsetMs <= FLASH_MAX_MEAN_ABS_MS, line: `mean absolute offset: ${meanAbsOffsetMs.toFixed(1)} ms (at most ${FLASH_MAX_MEAN_ABS_MS})` },
  ];
  const lines = checks.map((c) => `${mark(c.ok)}  ${c.line}`);
  let pass = checks.every((c) => c.ok);
  if (renderLatencyMs === null) {
    lines.push("n/a   mean vs render latency: not checked (no latency known; run with --sync-probe or pass --latency-ms)");
  } else {
    const ok = s.count > 0 && Math.abs(s.meanMs - renderLatencyMs) <= FLASH_LATENCY_TOLERANCE_MS;
    lines.push(`${mark(ok)}  mean ${s.meanMs.toFixed(1)} ms vs render latency ${renderLatencyMs.toFixed(1)} ms (within ${FLASH_LATENCY_TOLERANCE_MS})`);
    pass = pass && ok;
  }
  return { pass, lines };
}

/** Click-to-sound criteria: at least 8 pairs and a mean of absolute deltas of at most 20 ms (so +30 and -30 do not cancel). */
export function judgeClicks(s: Summary, meanAbsOffsetMs: number): Verdict {
  const checks = [
    { ok: s.count >= CLICK_MIN_PAIRS, line: `pairs: ${s.count} (need ${CLICK_MIN_PAIRS})` },
    { ok: s.count > 0 && meanAbsOffsetMs <= CLICK_MAX_MEAN_ABS_MS, line: `mean absolute click to sound: ${meanAbsOffsetMs.toFixed(1)} ms (at most ${CLICK_MAX_MEAN_ABS_MS}; signed mean ${s.meanMs.toFixed(1)} ms)` },
  ];
  return { pass: checks.every((c) => c.ok), lines: checks.map((c) => `${mark(c.ok)}  ${c.line}`) };
}
