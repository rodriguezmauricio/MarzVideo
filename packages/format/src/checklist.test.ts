import { describe, expect, test } from "vitest";
import { CHECKLIST_MAX, CHECKLIST_TEXT_MAX, checklistEdits, checklistItems, hasChecklist, splitTopics } from "./checklist";
import { parseEvents } from "./events";
import { parseProject, serializeProject } from "./project";

const base = (checklist?: object) => ({
  version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 60_000_000,
  source: { width: 1920, height: 1080, fps: 60 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
  output: { width: 1920, height: 1080, fps: 60 },
  edits: { zooms: [], cuts: [], ...(checklist ? { checklist } : {}) },
});

describe("splitTopics", () => {
  test("one topic per line, trimmed, empty lines dropped", () => {
    expect(splitTopics("  Pricing page \n\n\tRefunds\r\n  ")).toEqual(["Pricing page", "Refunds"]);
  });
  test("keeps 12 topics of 120 characters", () => {
    const many = Array.from({ length: 15 }, (_, i) => `Topic ${i + 1}`).join("\n");
    expect(splitTopics(many)).toHaveLength(CHECKLIST_MAX);
    expect(splitTopics("x".repeat(200))[0]).toHaveLength(CHECKLIST_TEXT_MAX);
  });
});

describe("edits.checklist", () => {
  test("old projects have no checklist", () => {
    const p = parseProject(base());
    expect(checklistItems(p)).toEqual([]);
    expect(hasChecklist(p)).toBe(false);
    expect(checklistEdits(p)).toEqual({ items: [] });
  });

  test("reads items, open ones with atUs null", () => {
    const p = parseProject(
      base({
        items: [
          { id: "c1", text: "Pricing page", atUs: 38_120_000, by: "auto" },
          { id: "c2", text: "Refunds", atUs: null },
          { id: "c3", text: "Odd by", atUs: 5, by: "telepathy" },
        ],
        liveImported: true,
      }),
    );
    expect(checklistItems(p)).toEqual([
      { id: "c1", text: "Pricing page", atUs: 38_120_000, by: "auto" },
      { id: "c2", text: "Refunds", atUs: null },
      { id: "c3", text: "Odd by", atUs: 5 },
    ]);
    expect(hasChecklist(p)).toBe(true);
    expect(checklistEdits(p).liveImported).toBe(true);
  });

  test("items this build cannot read are skipped but kept in the file", () => {
    const p = parseProject(base({ items: [{ id: "c1" }, { id: "c2", text: "Ok", atUs: null }, "junk"] }));
    expect(checklistItems(p).map((i) => i.id)).toEqual(["c2"]);
    expect(JSON.parse(serializeProject(p)).edits.checklist.items).toHaveLength(3);
  });
});

describe("checklist events", () => {
  test("list and tick lines parse; odd ones are skipped", () => {
    const text = [
      JSON.stringify({ type: "header", version: 1, source: { width: 1920, height: 1080, fps: 60 }, startedAt: "2026-11-19T00:00:00Z" }),
      JSON.stringify({ tUs: 0, type: "checklist", op: "list", items: [{ id: "c1", text: "Pricing page" }] }),
      JSON.stringify({ tUs: 41_890_000, type: "checklist", op: "tick", id: "c1", atUs: 38_120_000, by: "auto" }),
      JSON.stringify({ tUs: 42_000_000, type: "checklist", op: "tick", id: "c1" }),
      JSON.stringify({ tUs: 43_000_000, type: "checklist", op: "dance" }),
    ].join("\n");
    const { events } = parseEvents(text);
    expect(events).toEqual([
      { tUs: 0, type: "checklist", op: "list", items: [{ id: "c1", text: "Pricing page" }] },
      { tUs: 41_890_000, type: "checklist", op: "tick", id: "c1", atUs: 38_120_000, by: "auto" },
    ]);
  });
});
