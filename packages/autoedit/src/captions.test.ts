import { DEFAULT_AI_EDITS, parseProject, type Cut, type Project, type Word } from "@marz/format";
import { describe, expect, test } from "vitest";
import { blockSpans, captionBreakFor, captionLines, captionStarts, captionWords, transcriptParagraphs } from "./captions";
import { srtTime, toSrt, toVtt } from "./srt";

const ms = (n: number) => n * 1000;
let n = 0;
/** Words laid out every 400 ms (300 ms long). */
const say = (text: string, startMs = 0, stepMs = 400): Word[] =>
  text.split(" ").map((t, i) => ({ id: `w${++n}`, text: t, startUs: ms(startMs + i * stepMs), endUs: ms(startMs + i * stepMs + 300), p: 0.9 }));

const project = (cuts: Cut[] = [], edits: Record<string, unknown> = {}): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: ms(60_000),
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: { cuts, ...edits },
  });
const text = (ls: { words: { text: string }[] }[]) => ls.map((l) => l.words.map((w) => w.text).join(" "));

describe("captionLines", () => {
  test("words inside a cut are gone", () => {
    const ws = say("one two three four");
    const lines = captionLines(project([{ id: "c", startUs: ms(350), endUs: ms(1150) }]), ws, "subtitles");
    expect(text(lines)).toEqual(["one four"]);
  });

  test("override text replaces the word", () => {
    const ws = say("open marz now");
    const p = project([], { captions: { overrides: { [ws[1]!.id]: "Marz" }, hidden: [] } });
    expect(text(captionLines(p, ws, "subtitles"))).toEqual(["open Marz now"]);
  });

  test("hidden word is skipped", () => {
    const ws = say("open the menu");
    const p = project([], { captions: { overrides: {}, hidden: [ws[1]!.id] } });
    expect(text(captionLines(p, ws, "subtitles"))).toEqual(["open menu"]);
  });

  test("times are output times after a cut", () => {
    const ws = [...say("before", 0), ...say("after", 5000)];
    const cws = captionWords(project([{ id: "c", startUs: ms(1000), endUs: ms(4000) }]), ws);
    expect(cws[1]).toMatchObject({ text: "after", startUs: ms(2000), endUs: ms(2300) });
  });

  test("breaks at a sentence end", () => {
    const ws = say("This is it. And more");
    const lines = captionLines(project(), ws, "subtitles");
    expect(text(lines)).toEqual(["This is it.", "And more"]);
    expect(lines[0]!.block).not.toBe(lines[1]!.block);
  });

  test("breaks at a pause over 600 ms", () => {
    const ws = [...say("first part"), ...say("second part", 2000)];
    expect(text(captionLines(project(), ws, "subtitles"))).toEqual(["first part", "second part"]);
  });

  test("no subtitle line over 32 characters and at most two lines a block", () => {
    const ws = say("a quick brown fox jumps over the lazy dog while the editor keeps cutting every silence and filler word in the take");
    const lines = captionLines(project(), ws, "subtitles");
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(text([l])[0]!.length).toBeLessThanOrEqual(32);
    const perBlock = new Map<number, number>();
    for (const l of lines) perBlock.set(l.block, (perBlock.get(l.block) ?? 0) + 1);
    expect(Math.max(...perBlock.values())).toBeLessThanOrEqual(2);
  });

  test("highlight lines have 1 to 4 words, one line a block", () => {
    const ws = say("Then you click export and the video is ready in seconds");
    const lines = captionLines(project(), ws, "highlight");
    for (const l of lines) {
      expect(l.words.length).toBeGreaterThanOrEqual(1);
      expect(l.words.length).toBeLessThanOrEqual(4);
    }
    expect(new Set(lines.map((l) => l.block)).size).toBe(lines.length);
  });

  test("captions off gives no lines", () => {
    const p = project([], { ai: { ...DEFAULT_AI_EDITS, kinds: { ...DEFAULT_AI_EDITS.kinds, captions: false } } });
    expect(captionLines(p, say("hello there"), "subtitles")).toEqual([]);
  });

  test("a block holds 500 ms after its last word unless the next starts sooner", () => {
    const ws = [...say("one."), ...say("two.", 2000), ...say("three.", 2600)];
    const spans = blockSpans(captionLines(project(), ws, "subtitles"));
    expect(spans[0]).toMatchObject({ startUs: 0, endUs: ms(800) });
    expect(spans[1]!.endUs).toBe(ms(2600));
  });
});

describe("toSrt", () => {
  test("srt numbering and timestamps", () => {
    const ws = [...say("Hello there."), ...say("Second line", 3_723)];
    const srt = toSrt(captionLines(project(), ws, "subtitles"));
    expect(srt).toBe(
      "1\r\n00:00:00,000 --> 00:00:01,200\r\nHello there.\r\n\r\n" + "2\r\n00:00:03,723 --> 00:00:04,923\r\nSecond line\r\n\r\n",
    );
  });

  test("timestamp format", () => {
    expect(srtTime(3_723_456_789)).toBe("01:02:03,457");
  });

  test("empty transcript gives empty srt", () => {
    expect(toSrt(captionLines(project(), [], "subtitles"))).toBe("");
  });
});

describe("splits and joins", () => {
  const brk = (breaks: Record<string, string>) => project([], { captions: { overrides: {}, hidden: [], breaks } });
  const blocksText = (ls: ReturnType<typeof captionLines>) => {
    const out: string[] = [];
    let last = -1;
    for (const l of ls) {
      const t = l.words.map((w) => w.text).join(" ");
      if (l.block === last) out[out.length - 1] += " / " + t;
      else out.push(t);
      last = l.block;
    }
    return out;
  };

  test("split starts a new caption at the word", () => {
    const ws = say("open the menu and click export");
    expect(blocksText(captionLines(brk({ [ws[3]!.id]: "split" }), ws, "subtitles"))).toEqual(["open the menu", "and click export"]);
  });

  test("split works in highlight too", () => {
    const ws = say("one two three");
    expect(blocksText(captionLines(brk({ [ws[1]!.id]: "split" }), ws, "highlight"))).toEqual(["one", "two three"]);
  });

  test("join removes a sentence-end break", () => {
    const ws = say("Done. Next");
    expect(blocksText(captionLines(brk({ [ws[1]!.id]: "join" }), ws, "subtitles"))).toEqual(["Done. Next"]);
  });

  test("join removes a pause break", () => {
    const ws = [...say("first part"), ...say("second part", 2000)];
    expect(blocksText(captionLines(brk({ [ws[2]!.id]: "join" }), ws, "subtitles"))).toEqual(["first part second part"]);
  });

  test("join past the two-line limit wraps the line but keeps one caption", () => {
    const ws = say("aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg");
    const plain = captionLines(project(), ws, "subtitles");
    const second = plain.find((l) => l.block === 1)!;
    const joined = captionLines(brk({ [second.words[0]!.id]: "join" }), ws, "subtitles");
    expect(joined.filter((l) => l.block === 0).length).toBe(3);
    for (const l of joined) expect(text([l])[0]!.length).toBeLessThanOrEqual(32);
  });

  test("join in highlight keeps a long line together", () => {
    const ws = say("one two three four five six");
    const first = captionLines(project(), ws, "highlight");
    const next = first[1]!.words[0]!;
    expect(text(captionLines(brk({ [next.id]: "join" }), ws, "highlight"))).toEqual(["one two three four five", "six"]);
  });

  test("captionStarts lists the first word of every caption", () => {
    const ws = say("Done. Next one");
    expect([...captionStarts(captionLines(project(), ws, "subtitles"))]).toEqual([ws[0]!.id, ws[1]!.id]);
  });
});

describe("toVtt", () => {
  test("WebVTT header, dot timestamps, cue per caption", () => {
    const ws = [...say("Hello there."), ...say("Second line", 3_723)];
    expect(toVtt(captionLines(project(), ws, "subtitles"))).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nHello there.\n\n00:00:03.723 --> 00:00:04.923\nSecond line\n\n",
    );
  });

  test("edited text lands in the file", () => {
    const ws = say("open marz");
    const p = project([], { captions: { overrides: { [ws[1]!.id]: "Marz" }, hidden: [] } });
    expect(toVtt(captionLines(p, ws, "subtitles"))).toContain("open Marz");
    expect(toSrt(captionLines(p, ws, "subtitles"))).toContain("open Marz");
  });

  test("no captions gives an empty string", () => {
    expect(toVtt([])).toBe("");
  });
});

describe("captionBreakFor", () => {
  const withBreaks = (breaks: Record<string, string>) => project([], { captions: { overrides: {}, hidden: [], breaks } });

  test("split inside a caption, join at an automatic start", () => {
    const ws = say("Done. Next one");
    expect(captionBreakFor(project(), ws, "subtitles", ws[2]!.id, true)).toBe("split");
    expect(captionBreakFor(project(), ws, "subtitles", ws[1]!.id, false)).toBe("join");
  });

  test("undoing a hand split removes it instead of adding a join", () => {
    const ws = say("open the menu now");
    expect(captionBreakFor(withBreaks({ [ws[2]!.id]: "split" }), ws, "subtitles", ws[2]!.id, false)).toBeNull();
  });

  test("splitting where a join is removes the join", () => {
    const ws = say("Done. Next");
    expect(captionBreakFor(withBreaks({ [ws[1]!.id]: "join" }), ws, "subtitles", ws[1]!.id, true)).toBeNull();
  });

  test("nothing to change gives undefined", () => {
    const ws = say("Done. Next");
    expect(captionBreakFor(project(), ws, "subtitles", ws[1]!.id, true)).toBeUndefined();
    expect(captionBreakFor(project(), ws, "subtitles", ws[0]!.id, true)).toBeUndefined();
  });
});

describe("transcriptParagraphs", () => {
  test("every caption start opens a paragraph; words outside captions stay in place", () => {
    const ws = say("one two three four");
    const paras = transcriptParagraphs(ws, new Set([ws[0]!.id, ws[2]!.id]));
    expect(paras.map((p) => p.map((w) => w.text).join(" "))).toEqual(["one two", "three four"]);
  });

  test("a first word that is not a start still opens the first paragraph", () => {
    const ws = say("um one two");
    expect(transcriptParagraphs(ws, new Set([ws[1]!.id])).map((p) => p.length)).toEqual([3]);
  });
});
