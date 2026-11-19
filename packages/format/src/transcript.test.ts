import { describe, expect, test } from "vitest";
import { FormatError } from "./project";
import { languageAt, parseTranscript, serializeTranscript } from "./transcript";

const t = () => ({
  version: 1,
  engine: "whisper.cpp large-v3-turbo",
  mic: { bytes: 11520044, modifiedAt: "2026-11-17T19:00:00Z" },
  sections: [
    { startUs: 0, endUs: 10_000_000, language: "pt" },
    { startUs: 10_000_000, endUs: 20_000_000, language: "en" },
  ],
  words: [
    { id: "w1", text: "Então", startUs: 1_240_000, endUs: 1_610_000, p: 0.93 },
    { id: "w2", text: "vamos", startUs: 1_700_000, endUs: 1_900_000, p: 0.9 },
  ],
});

describe("parseTranscript", () => {
  test("parses a valid transcript", () => {
    const p = parseTranscript(t());
    expect(p.words).toHaveLength(2);
    expect(p.sections[1]?.language).toBe("en");
    expect(parseTranscript(JSON.parse(serializeTranscript(p)))).toEqual(p);
  });

  test("drops zero-length words", () => {
    const e = t();
    e.words.push({ id: "w3", text: "x", startUs: 5, endUs: 5, p: 1 });
    expect(parseTranscript(e).words.map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  test("sorts words by start", () => {
    const e = t();
    e.words.reverse();
    expect(parseTranscript(e).words.map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  test("keeps unknown fields", () => {
    const e = { ...t(), later: 1 };
    expect((parseTranscript(e) as Record<string, unknown>).later).toBe(1);
  });

  test("rejects a bad file", () => {
    expect(() => parseTranscript({ version: 2 })).toThrow(FormatError);
  });

  test("languageAt picks the section", () => {
    const p = parseTranscript(t());
    expect(languageAt(p, 3_000_000)).toBe("pt");
    expect(languageAt(p, 12_000_000)).toBe("en");
    expect(languageAt(p, 25_000_000)).toBeUndefined();
  });
});
