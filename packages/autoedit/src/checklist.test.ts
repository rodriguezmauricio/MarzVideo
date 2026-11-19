import { describe, expect, test } from "vitest";
import {
  AI_ASK_GAP_MS,
  checklistPrompt,
  matchTopics,
  normalizeWords,
  readChecklistAnswer,
  shouldAskAi,
  topicKeywords,
  wordsMatch,
  type AskState,
  type LiveWord,
} from "./checklist";

/** Words one every 400 ms from `startUs`. */
const say = (text: string, startUs = 0): LiveWord[] =>
  text.split(/\s+/).map((t, i) => ({ text: t, startUs: startUs + i * 400_000, endUs: startUs + i * 400_000 + 300_000 }));

describe("normalize and keywords", () => {
  test("lower case, accents and punctuation gone", () => {
    expect(normalizeWords("Preço, É  o Export!")).toEqual(["preco", "e", "o", "export"]);
  });
  test("keywords drop English and Portuguese stop words and repeats", () => {
    expect(topicKeywords("Show the export button")).toEqual(["show", "export", "button"]);
    expect(topicKeywords("Como funciona o preço do plano")).toEqual(["funciona", "preco", "plano"]);
    expect(topicKeywords("Pricing, pricing page")).toEqual(["pricing", "page"]);
  });
  test("a topic of stop words only keeps its words", () => {
    expect(topicKeywords("What is it")).toEqual(["what", "is", "it"]);
  });
});

describe("wordsMatch", () => {
  test("same word, shared stem, small typos", () => {
    expect(wordsMatch("export", "export")).toBe(true);
    expect(wordsMatch("pricing", "price")).toBe(true);
    expect(wordsMatch("exporting", "export")).toBe(true);
    expect(wordsMatch("pages", "page")).toBe(true);
    expect(wordsMatch("refunds", "refund")).toBe(true);
    expect(wordsMatch("whisperr", "whisper")).toBe(true);
    expect(wordsMatch("checklist", "cheklist")).toBe(true);
  });
  test("different words stay apart", () => {
    expect(wordsMatch("process", "product")).toBe(false);
    expect(wordsMatch("refund", "reference")).toBe(false);
    expect(wordsMatch("can", "cat")).toBe(false);
    expect(wordsMatch("plan", "plano")).toBe(true);
    expect(wordsMatch("plan", "play")).toBe(false);
  });
});

describe("matchTopics", () => {
  const topics = [
    { id: "c1", text: "Pricing page" },
    { id: "c2", text: "Refunds and cancellations" },
    { id: "c3", text: "Show the export button" },
  ];

  test("a topic ticks when most of its keywords were said close together", () => {
    const words = say("so first let us look at the pricing page here", 10_000_000);
    expect(matchTopics(topics, words)).toEqual([{ id: "c1", atUs: 10_000_000 + 7 * 400_000 }]);
  });

  test("one keyword of two is not enough", () => {
    expect(matchTopics(topics, say("the pricing is simple"))).toEqual([]);
  });

  test("three keywords need two; spread over more than 30 s they do not count", () => {
    expect(matchTopics(topics, say("now I click export and the button turns green"))).toEqual([{ id: "c3", atUs: 3 * 400_000 }]);
    const far = [...say("export", 0), ...say("button", 40_000_000)];
    expect(matchTopics(topics, far)).toEqual([]);
  });

  test("covered time is the first word of the winning window", () => {
    const words = [...say("refund", 1_000_000), ...say("cancel nothing", 60_000_000), ...say("refunds", 70_000_000)];
    expect(matchTopics(topics, words)).toEqual([{ id: "c2", atUs: 60_000_000 }]);
  });

  test("Portuguese with accents", () => {
    const pt = [{ id: "c1", text: "Preço do plano anual" }];
    expect(matchTopics(pt, say("agora o preco do plano e anual"))).toEqual([{ id: "c1", atUs: 2 * 400_000 }]);
  });
});

describe("Claude escalation", () => {
  const idle: AskState = { lastAskMs: null, wordsSinceAsk: 20, inFlight: false, asks: 0, disabled: false };

  test("asks only with open topics, enough new words, the gap passed, nothing running", () => {
    expect(shouldAskAi(idle, 0, 2)).toBe(true);
    expect(shouldAskAi(idle, 0, 0)).toBe(false);
    expect(shouldAskAi({ ...idle, wordsSinceAsk: 14 }, 0, 2)).toBe(false);
    expect(shouldAskAi({ ...idle, inFlight: true }, 0, 2)).toBe(false);
    expect(shouldAskAi({ ...idle, disabled: true }, 0, 2)).toBe(false);
    expect(shouldAskAi({ ...idle, asks: 20 }, 0, 2)).toBe(false);
    expect(shouldAskAi({ ...idle, lastAskMs: 1000 }, 1000 + AI_ASK_GAP_MS - 1, 2)).toBe(false);
    expect(shouldAskAi({ ...idle, lastAskMs: 1000 }, 1000 + AI_ASK_GAP_MS, 2)).toBe(true);
  });

  test("the prompt has the open topics and the timed transcript, nothing else", () => {
    const p = checklistPrompt([{ id: "c2", text: "Refunds" }], say("we give your money back", 61_000_000));
    expect(p).toContain("c2: Refunds");
    expect(p).toContain("[61.0] we give your money back");
  });

  test("the answer keeps known open ids once, times clamped to the sent window", () => {
    const answer = { covered: [{ id: "c2", atSec: 62.5 }, { id: "c2", atSec: 70 }, { id: "c9", atSec: 1 }, { id: "c3", atSec: 500 }, { id: "c4", atSec: "x" }] };
    expect(readChecklistAnswer(JSON.stringify(answer), ["c2", "c3", "c4"], 60_000_000, 120_000_000)).toEqual([
      { id: "c2", atUs: 62_500_000 },
      { id: "c3", atUs: 120_000_000 },
    ]);
    expect(readChecklistAnswer("not json", ["c2"], 0, 1)).toEqual([]);
    expect(readChecklistAnswer({ nope: 1 }, ["c2"], 0, 1)).toEqual([]);
  });
});
