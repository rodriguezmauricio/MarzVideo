import { describe, expect, it } from "vitest";
import { parseProject } from "@marz/format";
import { lookOf, setBackground } from "@marz/timeline";
import { checkLookName, defaultLookFor, EMPTY_LOOK_FILE, parseLookFile, removeLook, setDefaultLook, upsertLook } from "./lookFile";

const take = (createdAt: string) =>
  parseProject({
    version: 1, id: "p", name: "P", createdAt, durationUs: 10_000_000,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
  });
const studio = lookOf(setBackground({ style: "glow" })(take("2026-11-19T10:00:00Z")), "Studio", new Date("2026-11-19T10:00:00Z"));

describe("look file", () => {
  it("reads a missing or broken file as empty and keeps unknown keys", () => {
    expect(parseLookFile(null)).toEqual(EMPTY_LOOK_FILE);
    expect(parseLookFile("x")).toEqual(EMPTY_LOOK_FILE);
    const f = parseLookFile({ version: 1, later: 2, looks: [{ name: "A", background: null, captionStyles: {}, extra: 1 }, { nope: true }, { name: " " }], default: { name: "A" } });
    expect(f.later).toBe(2);
    expect(f.looks).toHaveLength(1);
    expect(f.looks[0]!.extra).toBe(1);
    expect(f.default).toBeNull();
  });

  it("checks names", () => {
    expect(checkLookName("  Studio   dark ")).toEqual({ ok: true, name: "Studio dark" });
    expect(checkLookName(" ")).toEqual({ ok: false, why: "Type a name for the look." });
    expect(checkLookName("x".repeat(41)).ok).toBe(false);
  });

  it("replaces a look with the same name ignoring case, and keeps it the default", () => {
    let f = upsertLook(EMPTY_LOOK_FILE, studio).file;
    f = setDefaultLook(f, "Studio", new Date("2026-11-19T12:00:00Z"));
    const r = upsertLook(f, { ...studio, name: "STUDIO", background: null });
    expect(r.replaced).toBe(true);
    expect(r.file.looks).toHaveLength(1);
    expect(r.file.looks[0]!.background).toBeNull();
    expect(r.file.default).toEqual({ name: "STUDIO", since: "2026-11-19T12:00:00.000Z" });
  });

  it("deleting the default look clears the default", () => {
    const f = setDefaultLook(upsertLook(EMPTY_LOOK_FILE, studio).file, "Studio");
    const g = removeLook(f, "studio");
    expect(g.looks).toEqual([]);
    expect(g.default).toBeNull();
  });

  it("picking the same default again keeps its date; an unknown name clears it", () => {
    const f = setDefaultLook(upsertLook(EMPTY_LOOK_FILE, studio).file, "Studio", new Date("2026-11-19T12:00:00Z"));
    expect(setDefaultLook(f, "studio", new Date("2026-11-20T00:00:00Z"))).toBe(f);
    expect(setDefaultLook(f, "Gone").default).toBeNull();
    expect(setDefaultLook(f, null).default).toBeNull();
  });

  it("gives the default look only to fresh takes recorded after it was picked", () => {
    const f = setDefaultLook(upsertLook(EMPTY_LOOK_FILE, studio).file, "Studio", new Date("2026-11-19T12:00:00Z"));
    expect(defaultLookFor(f, take("2026-11-19T12:30:00Z"))?.name).toBe("Studio");
    expect(defaultLookFor(f, take("2026-11-19T11:59:00Z"))).toBeNull();
    expect(defaultLookFor(f, setBackground({ style: "ink" })(take("2026-11-19T12:30:00Z")))).toBeNull();
    expect(defaultLookFor(EMPTY_LOOK_FILE, take("2026-11-19T12:30:00Z"))).toBeNull();
    expect(defaultLookFor({ ...f, looks: [] }, take("2026-11-19T12:30:00Z"))).toBeNull();
  });
});
