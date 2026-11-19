import { describe, expect, test } from "vitest";
import { checklistEdits, checklistItems, parseProject, type MarzEvent } from "@marz/format";
import { clearChecklistItem, coverChecklistItem, coverOpenItems, importLiveChecklist } from "./checklist";

const project = (checklist?: object) =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 60_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 60 },
    edits: { zooms: [], cuts: [], ...(checklist ? { checklist } : {}) },
  });

const list: MarzEvent = { tUs: 0, type: "checklist", op: "list", items: [{ id: "c1", text: "Pricing page" }, { id: "c2", text: "Refunds" }, { id: "c3", text: "Export" }] };
const tick = (id: string, atUs: number, by: "auto" | "ai" | "hand", tUs = atUs + 1_000_000): MarzEvent => ({ tUs, type: "checklist", op: "tick", id, atUs, by });

describe("importLiveChecklist", () => {
  test("turns the list and its ticks into edits.checklist once", () => {
    const p = importLiveChecklist([list, tick("c2", 5_000_000, "hand"), tick("c1", 20_000_000, "auto"), tick("c1", 30_000_000, "ai")])(project());
    expect(checklistItems(p)).toEqual([
      { id: "c1", text: "Pricing page", atUs: 20_000_000, by: "auto" },
      { id: "c2", text: "Refunds", atUs: 5_000_000, by: "hand" },
      { id: "c3", text: "Export", atUs: null },
    ]);
    expect(checklistEdits(p).liveImported).toBe(true);
    // Imported once: a second run changes nothing.
    expect(importLiveChecklist([list])(p)).toBe(p);
  });

  test("no list line: the project is unchanged; ticks of unknown ids and times past the end are dropped or clamped", () => {
    const p0 = project();
    expect(importLiveChecklist([tick("c1", 1, "auto")])(p0)).toBe(p0);
    const p = importLiveChecklist([list, tick("c9", 1, "auto"), tick("c3", 90_000_000, "hand")])(p0);
    expect(checklistItems(p).find((i) => i.id === "c3")).toEqual({ id: "c3", text: "Export", atUs: 60_000_000, by: "hand" });
  });
});

describe("cover and clear", () => {
  const p = importLiveChecklist([list])(project());

  test("cover sets the time and how; clear opens it again; unknown ids are no-ops", () => {
    const covered = coverChecklistItem("c2", 12_300_000, "editor")(p);
    expect(checklistItems(covered)[1]).toEqual({ id: "c2", text: "Refunds", atUs: 12_300_000, by: "editor" });
    const cleared = clearChecklistItem("c2")(covered);
    expect(checklistItems(cleared)[1]).toEqual({ id: "c2", text: "Refunds", atUs: null });
    expect(coverChecklistItem("c9", 1, "editor")(p)).toBe(p);
    expect(clearChecklistItem("c1")(p)).toBe(p);
  });

  test("other fields of the file stay", () => {
    const odd = project({ items: [{ id: "c1", text: "A", atUs: null, note: "keep" }, "junk"], liveImported: true });
    const next = coverChecklistItem("c1", 1_000_000, "editor")(odd);
    const items = checklistEdits(next).items as Record<string, unknown>[];
    expect(items[0]!.note).toBe("keep");
    expect(items[1]).toBe("junk");
  });
});

describe("coverOpenItems", () => {
  test("open topics found are covered; covered ones stay", () => {
    const p = importLiveChecklist([list, tick("c3", 2_000_000, "auto")])(project());
    const next = coverOpenItems([{ id: "c1", atUs: 40_200_000 }, { id: "c3", atUs: 50_000_000 }], "transcript")(p);
    expect(checklistItems(next)).toEqual([
      { id: "c1", text: "Pricing page", atUs: 40_200_000, by: "transcript" },
      { id: "c2", text: "Refunds", atUs: null },
      { id: "c3", text: "Export", atUs: 2_000_000, by: "auto" },
    ]);
    expect(coverOpenItems([], "transcript")(p)).toBe(p);
  });
});
