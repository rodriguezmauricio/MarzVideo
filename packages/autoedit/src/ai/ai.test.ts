import type { Word } from "@marz/format";
import { describe, expect, test } from "vitest";
import { chunkInput } from "./chunks";
import { FakeProvider } from "./fake";
import { buildPrompt } from "./prompt";
import { RESULT_SCHEMA } from "./schema";
import type { AiResult, EditPassInput } from "./types";
import { BAD_RESULT, mergeResults, validateResult } from "./validate";

const ms = (n: number) => n * 1000;
const words = (texts: string[], stepMs = 400): Word[] =>
  texts.map((text, i) => ({ id: `w${i + 1}`, text, startUs: ms(i * stepMs), endUs: ms(i * stepMs + 300), p: 0.9 }));

const sample = words("Olá, hoje eu vou mostrar o Marz. Agora a gente vai, agora a gente vai abrir o menu. Tipo, é muito simples.".split(" "));
const input: EditPassInput = {
  words: sample,
  sections: [{ startUs: 0, endUs: ms(10_000), language: "pt" }],
  ruleCuts: [{ startUs: ms(100), endUs: ms(200), reason: "silence", fromWordId: "w1", toWordId: "w2" }],
  candidates: [{ id: "k1", startUs: ms(4000), endUs: ms(6000), rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
};

describe("buildPrompt", () => {
  test("prompt contains every word id and no file paths", () => {
    const p = buildPrompt(input);
    for (const w of sample) expect(p).toContain(`${w.id}|${Math.round(w.startUs / 1000)}|${w.text}`);
    expect(p).toContain("k1 4.0s-6.0s");
    expect(p).toContain("silence 0.1s-0.2s");
    expect(p).not.toMatch(/[A-Za-z]:\\|\.wav|\.mp4|\.marz/);
  });
});

/** A tiny JSON Schema check for the subset RESULT_SCHEMA uses (object, array, string, required,
 * additionalProperties false). */
function conforms(schema: any, v: unknown): boolean {
  if (schema.type === "string") return typeof v === "string";
  if (schema.type === "array") return Array.isArray(v) && v.every((x) => conforms(schema.items, x));
  if (schema.type === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    if (!(schema.required ?? []).every((k: string) => k in o)) return false;
    if (schema.additionalProperties === false && Object.keys(o).some((k) => !(k in schema.properties))) return false;
    return Object.entries(o).every(([k, x]) => conforms(schema.properties[k], x));
  }
  return false;
}

describe("RESULT_SCHEMA", () => {
  test("schema matches the AiResult type", () => {
    const fixture: AiResult = {
      mistakes: [{ fromWordId: "w9", toWordId: "w12", why: "restarted sentence" }],
      contextFillers: ["w17"],
      zooms: [{ candidateId: "k1", fromWordId: "w13", toWordId: "w17" }],
    };
    expect(conforms(RESULT_SCHEMA, fixture)).toBe(true);
    expect(conforms(RESULT_SCHEMA, { mistakes: [], contextFillers: [] })).toBe(false);
    expect(conforms(RESULT_SCHEMA, { ...fixture, extra: 1 })).toBe(false);
  });
});

describe("validateResult", () => {
  test("validator drops unknown ids", () => {
    const v = validateResult(
      {
        mistakes: [{ fromWordId: "w9", toWordId: "nope", why: "x" }, { fromWordId: "w9", toWordId: "w12", why: "restart" }],
        contextFillers: ["w17", "zzz"],
        zooms: [{ candidateId: "k7", fromWordId: "w1", toWordId: "w2" }, { candidateId: "k1", fromWordId: "w13", toWordId: "w99" }],
      },
      input,
    );
    expect(v).toEqual({ mistakes: [{ fromWordId: "w9", toWordId: "w12", why: "restart" }], contextFillers: ["w17"], zooms: [] });
  });

  test("validator drops reversed and overlapping ranges", () => {
    const v = validateResult(
      {
        mistakes: [
          { fromWordId: "w12", toWordId: "w9", why: "reversed" },
          { fromWordId: "w9", toWordId: "w12", why: "a" },
          { fromWordId: "w11", toWordId: "w13", why: "overlaps a" },
        ],
        contextFillers: ["w10"], // inside a mistake already
        zooms: [
          { candidateId: "k1", fromWordId: "w13", toWordId: "w15" },
          { candidateId: "k1", fromWordId: "w16", toWordId: "w17" },
        ],
      },
      input,
    );
    expect(v).toEqual({
      mistakes: [{ fromWordId: "w9", toWordId: "w12", why: "a" }],
      contextFillers: [],
      zooms: [{ candidateId: "k1", fromWordId: "w13", toWordId: "w15" }],
    });
  });

  test("refuses a result that cuts most words", () => {
    const v = validateResult({ mistakes: [{ fromWordId: "w1", toWordId: "w15", why: "all" }], contextFillers: [], zooms: [] }, input);
    expect(v).toEqual({ refused: BAD_RESULT });
  });

  test("refuses garbage", () => {
    expect(validateResult("not json", input)).toEqual({ refused: BAD_RESULT });
    expect(validateResult(null, input)).toEqual({ refused: BAD_RESULT });
  });

  test("missing lists read as empty", () => {
    expect(validateResult({}, input)).toEqual({ mistakes: [], contextFillers: [], zooms: [] });
  });
});

describe("chunks", () => {
  test("one chunk up to 30 minutes", () => {
    expect(chunkInput(input, 30 * 60_000_000)).toEqual([input]);
  });

  test("chunks over 30 minutes and dedupes the overlap", () => {
    const long = words(Array.from({ length: 3000 }, (_, i) => `w${i}`), 800); // 40 minutes
    const durationUs = 40 * 60_000_000;
    const chunks = chunkInput({ words: long, sections: [], ruleCuts: [], candidates: [] }, durationUs);
    expect(chunks).toHaveLength(3);
    const firstEnd = chunks[0]!.words.at(-1)!.startUs;
    const secondStart = chunks[1]!.words[0]!.startUs;
    expect(firstEnd - secondStart).toBeGreaterThanOrEqual(28_000_000); // 30 s overlap (words every 0.8 s)
    expect(chunks.at(-1)!.words.at(-1)!.id).toBe(long.at(-1)!.id);

    // The same mistake found in both chunks (inside the overlap) is applied once.
    const shared = chunks[1]!.words[3]!;
    const r1: AiResult = { mistakes: [{ fromWordId: shared.id, toWordId: shared.id, why: "a" }], contextFillers: ["w5"], zooms: [] };
    const r2: AiResult = { mistakes: [{ fromWordId: shared.id, toWordId: chunks[1]!.words[4]!.id, why: "b" }], contextFillers: ["w5"], zooms: [] };
    const merged = mergeResults([r1, r2], long);
    expect(merged.mistakes).toHaveLength(1);
    expect(merged.contextFillers).toEqual(["w5"]);
  });
});

describe("FakeProvider", () => {
  test("fake provider result validates against the sample", async () => {
    const r = await new FakeProvider(0).editPass(input, new AbortController().signal);
    const v = validateResult(r, input);
    expect("refused" in v).toBe(false);
    const ok = v as AiResult;
    expect(ok.mistakes).toEqual([{ fromWordId: "w8", toWordId: "w11", why: "restarted sentence" }]); // "Agora a gente vai,"
    expect(ok.contextFillers).toEqual(["w19"]); // "Tipo,"
    expect(ok.zooms.map((z) => z.candidateId)).toEqual(["k1"]);
  });

  test("abort rejects", async () => {
    const ac = new AbortController();
    const p = new FakeProvider(1000).editPass(input, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
