import { z } from "zod";
import { FormatError } from "./project";

/** `transcript.json`: derived from `mic.wav` by the transcription step, never written by the editor.
 * Times are integer microseconds in source time (`tracks.mic.offsetUs` already added). */
const Us = z.number().int();

const WordSchema = z
  .object({ id: z.string(), text: z.string(), startUs: Us, endUs: Us, p: z.number() })
  .passthrough();

const SectionSchema = z.object({ startUs: Us, endUs: Us, language: z.string() }).passthrough();

const TranscriptSchema = z
  .object({
    version: z.literal(1),
    engine: z.string(),
    mic: z.object({ bytes: z.number(), modifiedAt: z.string() }).passthrough(),
    sections: z.array(SectionSchema).default([]),
    words: z.array(WordSchema).default([]),
  })
  .passthrough();

export type Word = z.infer<typeof WordSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;

/** Parses `transcript.json`: drops words with no length, sorts words by start, keeps unknown fields. */
export function parseTranscript(json: unknown): Transcript {
  const r = TranscriptSchema.safeParse(json);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new FormatError(`Invalid transcript.json: ${msg}`);
  }
  const t = r.data;
  return {
    ...t,
    words: t.words.filter((w) => w.endUs > w.startUs).sort((a, b) => a.startUs - b.startUs),
    sections: [...t.sections].sort((a, b) => a.startUs - b.startUs),
  };
}

export function serializeTranscript(t: Transcript): string {
  return JSON.stringify(t, null, 2) + "\n";
}

/** The language of the section that holds `us`, or undefined between sections. */
export function languageAt(t: Transcript, us: number): string | undefined {
  return t.sections.find((s) => us >= s.startUs && us < s.endUs)?.language;
}
