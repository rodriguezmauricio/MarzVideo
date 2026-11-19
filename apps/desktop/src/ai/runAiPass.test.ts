import { AiProviderError, FakeProvider, type AiProvider, type Levels } from "@marz/autoedit";
import { parseProject, parseTranscript, type Project, type Transcript, type Word } from "@marz/format";
import { addCut, History } from "@marz/timeline";
import { describe, expect, test, vi } from "vitest";
import { runAiPass, statusText, TranscribeFailure, type AiPassDeps, type AiStatus } from "./runAiPass";

const ms = (n: number) => n * 1000;
const S = 1_000_000;

function project(withMic = true): Project {
  return parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20 * S,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: {
      screen: { file: "screen.mp4", offsetUs: 0 },
      ...(withMic ? { mic: { file: "mic.wav", offsetUs: 0, volume: 1, muted: false } } : {}),
    },
    output: { width: 1920, height: 1080, fps: 30 },
  });
}

/** "Agora a gente vai, agora a gente vai abrir o menu. [3 s] Tipo, é simples." */
function transcript(): Transcript {
  const texts = "Agora a gente vai, agora a gente vai abrir o menu.".split(" ");
  const words: Word[] = texts.map((text, i) => ({ id: `w${i + 1}`, text, startUs: ms(500 + i * 400), endUs: ms(800 + i * 400), p: 0.9 }));
  const after = ["Tipo,", "é", "simples."].map((text, i) => ({ id: `w${12 + i}`, text, startUs: ms(8000 + i * 400), endUs: ms(8300 + i * 400), p: 0.9 }));
  return parseTranscript({ version: 1, engine: "test", mic: { bytes: 1, modifiedAt: "x" }, sections: [{ startUs: 0, endUs: 20 * S, language: "pt" }], words: [...words, ...after] });
}

/** Levels with voice exactly under the transcript words. */
function levelsFor(t: Transcript | null): Levels {
  const rms = new Float32Array(2000).fill(0.0005);
  for (const w of t?.words ?? []) for (let i = w.startUs / 10_000; i < w.endUs / 10_000; i++) rms[i] = 0.2;
  return { stepUs: 10000, offsetUs: 0, rms, floor: 0.01 };
}

function deps(over: Partial<AiPassDeps> = {}, t: Transcript | null = transcript()): AiPassDeps & { statuses: AiStatus[] } {
  const statuses: AiStatus[] = [];
  return {
    history: new History(project()),
    events: [],
    provider: new FakeProvider(0),
    transcribe: async (onPct) => onPct(1),
    readTranscript: async () => t,
    readLevels: async () => levelsFor(t),
    onStatus: (s) => statuses.push(s),
    signal: new AbortController().signal,
    now: () => new Date("2026-11-19T00:00:00Z"),
    statuses,
    ...over,
  };
}

describe("runAiPass", () => {
  test("runs transcribe, rules, ai, apply in order", async () => {
    const order: string[] = [];
    const d = deps({
      transcribe: async (onPct) => {
        order.push("transcribe");
        onPct(0.5);
      },
      readTranscript: async () => (order.push("read"), transcript()),
      provider: { name: "spy", model: "m", editPass: async (input, s) => (order.push(`ai:${input.words.length}`), new FakeProvider(0).editPass(input, s)) },
    });
    const applySpy = vi.spyOn(d.history, "apply");
    const out = await runAiPass(d);
    expect(order).toEqual(["transcribe", "read", "ai:14"]);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(out.warnings).toEqual([]);
    const p = d.history.current;
    expect(p.edits.cuts.some((c) => c.reason === "mistake")).toBe(true); // the restarted sentence
    expect(p.edits.cuts.some((c) => c.reason === "silence")).toBe(true); // the 3 s gap
    expect(p.edits.ai?.lastRun).toMatchObject({ provider: "spy", languages: ["pt"] });
    expect(d.statuses.map((s) => s.step)).toEqual(["transcribing", "transcribing", "editing", "done"]);
    expect(statusText(d.statuses.at(-1)!)).toMatch(/^AI edit: \d+ cuts, captions\. Ctrl\+Z undoes it$/);
  });

  test("skips transcription when there is no transcribe step and still uses the transcript", async () => {
    const d = deps({ transcribe: null });
    await runAiPass(d);
    expect(d.statuses[0]!.step).toBe("editing");
    expect(d.history.current.edits.cuts.length).toBeGreaterThan(0);
  });

  test("provider failure still applies rule cuts and captions and warns", async () => {
    const failing: AiProvider = { name: "claude-code", model: "sonnet", editPass: async () => { throw new AiProviderError("notSignedIn", "x"); } };
    const d = deps({ provider: failing });
    const out = await runAiPass(d);
    expect(out.warnings).toEqual(["Claude Code is not signed in. Open it once and sign in."]);
    const reasons = d.history.current.edits.cuts.map((c) => c.reason);
    expect(reasons).toContain("silence");
    expect(reasons).not.toContain("mistake");
    expect(d.statuses.at(-1)).toMatchObject({ step: "done", captions: true });
  });

  test("a refused AI answer warns with the bad result sentence", async () => {
    const greedy: AiProvider = {
      name: "x", model: "y",
      editPass: async (input) => ({ mistakes: [{ fromWordId: input.words[0]!.id, toWordId: input.words.at(-1)!.id, why: "all" }], contextFillers: [], zooms: [] }),
    };
    const out = await runAiPass(deps({ provider: greedy }));
    expect(out.warnings).toEqual(["AI result looked wrong. Mistakes and AI zooms were skipped."]);
  });

  test("transcription failure cuts silences from levels only and warns", async () => {
    const t = transcript();
    const d = deps({
      transcribe: async () => { throw new TranscribeFailure("noWhisper"); },
      readTranscript: async () => null,
      readLevels: async () => levelsFor(t),
    }, null);
    const out = await runAiPass(d);
    expect(out.warnings).toEqual(["Whisper is missing. Install it or set MARZ_WHISPER. Only silences were cut."]);
    const cuts = d.history.current.edits.cuts;
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.every((c) => c.reason === "silence" && c.origin === "ai")).toBe(true);
  });

  test("closing the project aborts the pass", async () => {
    const ac = new AbortController();
    const d = deps({ signal: ac.signal, provider: new FakeProvider(50) });
    const applySpy = vi.spyOn(d.history, "apply");
    const run = runAiPass(d);
    setTimeout(() => ac.abort(), 5);
    const out = await run;
    expect(applySpy).not.toHaveBeenCalled();
    expect(out.applied).toBe(false);
  });

  test("edits during the run win", async () => {
    const d = deps({ provider: new FakeProvider(30) });
    const run = runAiPass(d);
    // While Claude "thinks", he cuts over the 3 s gap himself.
    await new Promise((r) => setTimeout(r, 5));
    d.history.apply(addCut({ id: "his", startUs: ms(5000), endUs: ms(6000) }));
    await run;
    const cuts = d.history.current.edits.cuts;
    expect(cuts.find((c) => c.id === "his")).toBeDefined();
    expect(cuts.filter((c) => c.origin === "ai").some((c) => c.startUs < ms(6000) && c.endUs > ms(5000))).toBe(false);
    d.history.undo(); // undoes the AI step only
    expect(d.history.current.edits.cuts.map((c) => c.id)).toEqual(["his"]);
  });

  test("no speech gives the nothing status", async () => {
    const empty = parseTranscript({ version: 1, engine: "t", mic: { bytes: 1, modifiedAt: "x" }, sections: [], words: [] });
    const d = deps({}, empty);
    const before = d.history.current;
    const out = await runAiPass(d);
    expect(d.statuses.at(-1)).toEqual({ step: "nothing" });
    expect(statusText(d.statuses.at(-1)!)).toBe("No speech found. Nothing was cut.");
    expect(d.history.current).toBe(before);
    expect(out.applied).toBe(false);
  });

  test("no mic track skips transcription", async () => {
    const transcribe = vi.fn(async () => {});
    const d = deps({ history: new History(project(false)), transcribe, readLevels: async () => null });
    await runAiPass(d);
    expect(transcribe).not.toHaveBeenCalled();
    expect(d.statuses.at(-1)).toEqual({ step: "nothing" });
  });
});
