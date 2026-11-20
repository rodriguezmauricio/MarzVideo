import { describe, expect, it, vi } from "vitest";
import { AI_ASK_GAP_MS, type LiveWord } from "@marz/autoedit";
import { LiveChecklist, type LiveItem } from "./liveChecklist";

const say = (text: string, startUs: number): LiveWord[] =>
  text.split(" ").map((t, i) => ({ text: t, startUs: startUs + i * 400_000, endUs: startUs + i * 400_000 + 300_000 }));

const items = (done: string[] = []): LiveItem[] =>
  [
    { id: "c1", text: "Pricing page" },
    { id: "c2", text: "Refunds" },
  ].map((t) => ({ ...t, atUs: done.includes(t.id) ? 1 : null }));

function setup(ai: (prompt: string) => Promise<string> = () => Promise.resolve('{"covered":[]}')) {
  let now = 0;
  const tick = vi.fn();
  const askAi = vi.fn(ai);
  const live = new LiveChecklist({ tick, askAi, nowMs: () => now });
  return { live, tick, askAi, advance: (ms: number) => (now += ms) };
}

describe("LiveChecklist", () => {
  it("ticks a topic once when the words match, by auto", () => {
    const { live, tick } = setup();
    live.onWords(say("here is the pricing page", 5_000_000), items());
    expect(tick).toHaveBeenCalledWith("c1", 5_000_000 + 3 * 400_000, "auto");
    // The state from Rust may lag: no second tick for the same topic.
    live.onWords(say("pricing page again", 9_000_000), items());
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("asks Claude about open topics once enough words came, then not before the gap", async () => {
    const { live, tick, askAi, advance } = setup(() => Promise.resolve('{"covered":[{"id":"c2","atSec":12}]}'));
    const talk = say("we give you all of your money back within thirty days if you do not like the product", 10_000_000);
    live.onWords(talk, items());
    expect(askAi).toHaveBeenCalledTimes(1);
    const prompt = askAi.mock.calls[0]![0];
    expect(prompt).toContain("c2: Refunds");
    expect(prompt).toContain("c1: Pricing page"); // c1 is open too
    expect(prompt).toContain("[10.0] we give you");
    await live.idle();
    expect(tick).toHaveBeenCalledWith("c2", 12_000_000, "ai");
    live.onWords(say("and more words here to count up past the minimum again for a new ask now", 20_000_000), items(["c2"]));
    expect(askAi).toHaveBeenCalledTimes(1);
    advance(AI_ASK_GAP_MS);
    live.onWords(say("one more", 30_000_000), items(["c2"]));
    expect(askAi).toHaveBeenCalledTimes(2);
  });

  it.each(["notInstalled", "off", "noKey", "badKey"])("stops asking for the rest of the recording on %s", async (kind) => {
    const { live, askAi, advance } = setup(() => Promise.reject({ kind }));
    const talk = say("a b c d e f g h i j k l m n o p", 0);
    live.onWords(talk, items());
    await live.idle();
    advance(AI_ASK_GAP_MS);
    live.onWords(say("q r s t u v w x y z aa bb cc dd ee ff", 10_000_000), items());
    expect(askAi).toHaveBeenCalledTimes(1);
  });

  it("a failed ask is tried again after the gap", async () => {
    const { live, askAi, advance } = setup(() => Promise.reject({ kind: "failed", detail: "x" }));
    live.onWords(say("a b c d e f g h i j k l m n o p", 0), items());
    await live.idle();
    advance(AI_ASK_GAP_MS);
    live.onWords(say("q r s t u v w x y z aa bb cc dd ee ff", 10_000_000), items());
    expect(askAi).toHaveBeenCalledTimes(2);
  });

  it("does nothing when every topic is ticked", () => {
    const { live, tick, askAi } = setup();
    live.onWords(say("pricing page refunds and lots more words to pass the minimum count for an ask", 0), items(["c1", "c2"]));
    expect(tick).not.toHaveBeenCalled();
    expect(askAi).not.toHaveBeenCalled();
  });
});
