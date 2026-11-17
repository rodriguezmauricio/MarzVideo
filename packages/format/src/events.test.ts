import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FormatError } from "./project";
import { parseEvents } from "./events";

const header = '{"type":"header","version":1,"source":{"width":2560,"height":1440,"fps":60},"startedAt":"2026-11-15T19:00:00Z"}';

describe("parseEvents", () => {
  test("parses header and events in order", () => {
    const text = [
      header,
      '{"tUs":16000,"type":"cursor","x":1203,"y":644}',
      '{"tUs":812000,"type":"click","button":"left","state":"down","x":1203,"y":644}',
      '{"tUs":903000,"type":"click","button":"left","state":"up","x":1203,"y":644}',
      '{"tUs":4100000,"type":"zoom","presetId":"p1","action":"in"}',
      '{"tUs":9000000,"type":"pause"}',
      '{"tUs":9000000,"type":"resume"}',
    ].join("\n");
    const { header: h, events } = parseEvents(text);
    expect(h.source).toEqual({ width: 2560, height: 1440, fps: 60 });
    expect(events.map((e) => e.type)).toEqual(["cursor", "click", "click", "zoom", "pause", "resume"]);
    expect(events[1]).toMatchObject({ tUs: 812000, state: "down", x: 1203, y: 644 });
  });

  test("ignores unknown event types", () => {
    const { events } = parseEvents(`${header}\n{"tUs":1,"type":"stroke","points":[]}\n{"tUs":2,"type":"cursor","x":1,"y":2}`);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("cursor");
  });

  test("drops an unparseable final line", () => {
    const { events } = parseEvents(`${header}\n{"tUs":2,"type":"cursor","x":1,"y":2}\n{"tUs":3,"type":"cur`);
    expect(events).toHaveLength(1);
  });

  test("throws on a middle line that is not JSON", () => {
    expect(() => parseEvents(`${header}\n{oops}\n{"tUs":2,"type":"cursor","x":1,"y":2}`)).toThrowError(FormatError);
  });

  test("header only returns no events", () => {
    expect(parseEvents(header).events).toEqual([]);
    expect(parseEvents(header + "\n").events).toEqual([]);
  });

  test("empty text throws mentioning header", () => {
    expect(() => parseEvents("")).toThrowError(/header/);
  });

  test("tolerates CRLF line endings", () => {
    const { events } = parseEvents(`${header}\r\n{"tUs":2,"type":"cursor","x":1,"y":2}\r\n`);
    expect(events).toHaveLength(1);
  });
});

describe("parseEvents tolerance for odd events", () => {
  test("a click with an unknown button is skipped, the rest of the file still loads", () => {
    const text = [
      header,
      '{"tUs":1000,"type":"click","button":"x1","state":"down","x":1,"y":2}',
      '{"tUs":2000,"type":"cursor","x":3,"y":4}',
    ].join("\n");
    const { events } = parseEvents(text);
    expect(events.map((e) => e.type)).toEqual(["cursor"]);
  });

  test("an event with a non-integer time is skipped", () => {
    const text = [header, '{"tUs":1.5,"type":"cursor","x":1,"y":2}', '{"tUs":2000,"type":"cursor","x":3,"y":4}'].join("\n");
    expect(parseEvents(text).events).toHaveLength(1);
  });
});

describe("parseEvents with the Rust writer fixture", () => {
  test("parses the Rust writer fixture", () => {
    const url = new URL("../../../crates/capture/tests/fixtures/events-sample.jsonl", import.meta.url);
    const { header, events } = parseEvents(readFileSync(url, "utf8"));
    expect(header).toEqual({ version: 1, source: { width: 2560, height: 1440, fps: 60 }, startedAt: "2026-11-17T10:00:00Z" });
    // The writer's `zoom out` line has no presetId, which the current ZoomEventSchema skips as an odd event.
    expect(events.map((e) => e.type)).toEqual(["cursor", "cursor", "click", "click", "click", "click", "zoom", "pause", "resume"]);
    expect(events.find((e) => e.type === "zoom")).toEqual({ tUs: 4100000, type: "zoom", presetId: "p1", action: "in" });
  });
});
