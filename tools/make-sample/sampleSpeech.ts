import { parseTranscript, type Transcript, type Word } from "@marz/format";

/** A short scripted take for the sample: Portuguese then English, with a stretched "umm", a lone
 * held "é", "tipo", a restarted sentence and a 2 s pause, so every AI pass rule has something to do.
 * A number is a pause in ms; `[text, ms]` forces a word length. */
type Item = string | number | [string, number];

const PT: Item[] = [
  500, "Olá,", ["umm", 520], 250, "hoje", "eu", "vou", "mostrar", "o", "Marz.", 450,
  "Agora", "a", "gente", "vai,", 200, "agora", "a", "gente", "vai", "abrir", "o", "menu.", 500,
  ["é", 480], 500, "Tipo,", "é", "muito", "simples.", 2000,
];
const EN: Item[] = [
  "So,", "this", "is", "the", "editor.", 400, ["uh", 380], 200, "You", "can", "cut,", "zoom", "and", "export.", 450,
  "Like,", "it", "is", "really", "fast.", 300, "Thanks.",
];

const GAP_US = 70_000;
const wordUs = (text: string) => Math.min(560_000, 140_000 + text.length * 45_000);

/** Words laid out from `startUs`, with `nextId` numbering. Returns the words and where it ended. */
function layout(items: Item[], startUs: number, firstId: number): { words: Word[]; endUs: number } {
  const words: Word[] = [];
  let t = startUs;
  for (const it of items) {
    if (typeof it === "number") {
      t += it * 1000;
      continue;
    }
    const [text, ms] = typeof it === "string" ? [it, undefined] : it;
    const len = ms !== undefined ? ms * 1000 : wordUs(text);
    words.push({ id: `w${firstId + words.length}`, text, startUs: t, endUs: t + len, p: 0.9 });
    t += len + GAP_US;
  }
  return { words, endUs: t };
}

/** The sample transcript, cut down to the words that end before `durationUs`. Source time. */
export function sampleTranscript(durationUs: number, mic: { bytes: number; modifiedAt: string }): Transcript {
  const pt = layout(PT, 0, 1);
  const en = layout(EN, pt.endUs, pt.words.length + 1);
  const words = [...pt.words, ...en.words].filter((w) => w.endUs <= durationUs - 100_000);
  const sections = [
    { startUs: 0, endUs: pt.endUs, language: "pt" },
    { startUs: pt.endUs, endUs: Math.max(pt.endUs, en.endUs), language: "en" },
  ]
    .map((s) => ({ ...s, endUs: Math.min(s.endUs, durationUs) }))
    .filter((s) => s.endUs > s.startUs);
  return parseTranscript({ version: 1, engine: "sample", mic, sections, words });
}

/** A 48 kHz s16 mono WAV where each word is a voiced tone and everything else is near silence, so
 * level-based rules see speech exactly where the transcript has words. `micOffsetUs` maps source
 * time to file time. */
export function speechWav(durationUs: number, words: Word[], micOffsetUs: number): Uint8Array {
  const rate = 48_000;
  const n = Math.round((durationUs / 1e6) * rate);
  const pcm = new Int16Array(n);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < n; i++) pcm[i] = Math.round(noise() * 0.006 * 32767);
  for (const w of words) {
    const a = Math.max(0, Math.round(((w.startUs - micOffsetUs) / 1e6) * rate));
    const b = Math.min(n, Math.round(((w.endUs - micOffsetUs) / 1e6) * rate));
    for (let i = a; i < b; i++) {
      const t = i / rate;
      const env = Math.min(1, (i - a) / 480, (b - i) / 480);
      const v = 0.25 * Math.sin(2 * Math.PI * 170 * t) + 0.12 * Math.sin(2 * Math.PI * 340 * t);
      pcm[i] = Math.round(v * env * 32767);
    }
  }
  const data = new Uint8Array(pcm.buffer);
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + data.length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}
