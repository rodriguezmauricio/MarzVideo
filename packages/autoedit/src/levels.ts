/** Mic loudness in 10 ms steps, in source time: step `i` covers `offsetUs + i * 10 ms`. */
export type Levels = { stepUs: 10000; offsetUs: number; rms: Float32Array; floor: number };

export const LEVEL_STEP_US = 10_000;
/** Lowest silence floor: a dead quiet mic (digital zero between words) still needs a floor. */
const MIN_FLOOR = 0.002;

/** Reads a PCM s16 WAV (M1 writes 48 kHz mono; other rates and channel counts are handled) into
 * 10 ms RMS steps. `floor` is the 20th percentile RMS times 2: below it counts as silence. */
export function micLevels(wav: ArrayBuffer, offsetUs: number): Levels {
  const dv = new DataView(wav);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (wav.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("mic.wav is not a WAV file");
  let rate = 48_000;
  let channels = 1;
  let bits = 16;
  let dataAt = -1;
  let dataLen = 0;
  for (let o = 12; o + 8 <= wav.byteLength; ) {
    const id = tag(o);
    const len = dv.getUint32(o + 4, true);
    if (id === "fmt ") {
      channels = dv.getUint16(o + 10, true);
      rate = dv.getUint32(o + 12, true);
      bits = dv.getUint16(o + 22, true);
    } else if (id === "data") {
      dataAt = o + 8;
      // A recorder that crashed may leave the length at 0 or too large: use what is there.
      dataLen = len === 0 || dataAt + len > wav.byteLength ? wav.byteLength - dataAt : len;
      break;
    }
    o += 8 + len + (len & 1);
  }
  if (dataAt < 0) throw new Error("mic.wav has no data chunk");
  if (bits !== 16) throw new Error(`mic.wav is ${bits}-bit, expected 16-bit`);

  const frameBytes = 2 * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const perStep = Math.max(1, Math.round((rate * LEVEL_STEP_US) / 1e6));
  const steps = Math.ceil(frames / perStep);
  const rms = new Float32Array(steps);
  for (let s = 0; s < steps; s++) {
    let sum = 0;
    const a = s * perStep;
    const b = Math.min(frames, a + perStep);
    for (let f = a; f < b; f++) {
      const v = dv.getInt16(dataAt + f * frameBytes, true) / 32768; // first channel
      sum += v * v;
    }
    rms[s] = Math.sqrt(sum / Math.max(1, b - a));
  }
  return { stepUs: LEVEL_STEP_US, offsetUs, rms, floor: floorOf(rms) };
}

function floorOf(rms: Float32Array): number {
  if (rms.length === 0) return MIN_FLOOR;
  const sorted = Float32Array.from(rms).sort();
  return Math.max(MIN_FLOOR, (sorted[Math.floor(sorted.length * 0.2)] ?? 0) * 2);
}

const stepRange = (l: Levels, startUs: number, endUs: number): [number, number] => [
  Math.max(0, Math.floor((startUs - l.offsetUs) / l.stepUs)),
  Math.min(l.rms.length, Math.ceil((endUs - l.offsetUs) / l.stepUs)),
];

/** Mean RMS over a source time range (0 outside the recording). */
export function meanLevel(l: Levels, startUs: number, endUs: number): number {
  const [a, b] = stepRange(l, startUs, endUs);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += l.rms[i]!;
  return sum / (b - a);
}

/** Loudest 10 ms step over a source time range (0 outside the recording). */
export function maxLevel(l: Levels, startUs: number, endUs: number): number {
  const [a, b] = stepRange(l, startUs, endUs);
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, l.rms[i]!);
  return m;
}

/** Quiet stretches of at least `minUs`, in source time, from the levels alone. */
export function quietRanges(l: Levels, minUs: number): Array<{ startUs: number; endUs: number }> {
  const out: Array<{ startUs: number; endUs: number }> = [];
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0 && (end - start) * l.stepUs >= minUs)
      out.push({ startUs: l.offsetUs + start * l.stepUs, endUs: l.offsetUs + end * l.stepUs });
    start = -1;
  };
  for (let i = 0; i < l.rms.length; i++) {
    if (l.rms[i]! < l.floor) {
      if (start < 0) start = i;
    } else flush(i);
  }
  flush(l.rms.length);
  return out;
}
