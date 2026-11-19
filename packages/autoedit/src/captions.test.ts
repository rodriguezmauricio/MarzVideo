import { DEFAULT_AI_EDITS, parseProject, type Cut, type Project, type Word } from "@marz/format";
import { describe, expect, test } from "vitest";
import { blockSpans, captionLines, captionWords } from "./captions";
import { srtTime, toSrt } from "./srt";

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
