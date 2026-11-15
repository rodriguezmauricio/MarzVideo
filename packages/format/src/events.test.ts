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

  test("throws on a bad middle line", () => {
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
