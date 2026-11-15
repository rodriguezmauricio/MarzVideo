import { describe, expect, test } from "vitest";
import { loadEventsOrEmpty } from "./loadEvents";

const header = '{"type":"header","version":1,"source":{"width":100,"height":100,"fps":30},"startedAt":"2026-11-15T00:00:00Z"}';

describe("loadEventsOrEmpty", () => {
  test("returns the events when the file is fine", async () => {
    const r = await loadEventsOrEmpty(async () => `${header}\n{"tUs":1,"type":"cursor","x":1,"y":2}`);
    expect(r.events).toHaveLength(1);
    expect(r.warning).toBeNull();
  });

  test("an empty file opens with no events and a warning", async () => {
    const r = await loadEventsOrEmpty(async () => "");
    expect(r.events).toEqual([]);
    expect(r.warning).toMatch(/events/i);
  });

  test("a missing file opens with no events and a warning", async () => {
    const r = await loadEventsOrEmpty(async () => {
      throw new Error("Could not read events.jsonl (404)");
    });
    expect(r.events).toEqual([]);
    expect(r.warning).toMatch(/events/i);
  });

  test("events come back sorted by time", async () => {
    const r = await loadEventsOrEmpty(
      async () => `${header}\n{"tUs":9,"type":"cursor","x":1,"y":2}\n{"tUs":3,"type":"cursor","x":1,"y":2}`,
    );
    expect(r.events.map((e) => e.tUs)).toEqual([3, 9]);
  });
});
