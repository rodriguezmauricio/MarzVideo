import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { cameraEdits, DEFAULT_CAMERA_EDITS, FormatError, parseProject, serializeProject } from "./project";

const example = () => ({
  version: 1,
  id: "6f1c2a9e-0000-4000-8000-000000000001",
  name: "My Recording",
  createdAt: "2026-11-15T19:00:00Z",
  durationUs: 63500000,
  source: { width: 2560, height: 1440, fps: 60 },
  tracks: {
    screen: { file: "screen.mp4", offsetUs: 0 },
    mic: { file: "mic.wav", offsetUs: 12400, volume: 1, muted: false },
  },
  output: { width: 1920, height: 1080, fps: 60 },
  zoomPresets: [{ id: "p1", name: "Editor", rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
  edits: {
    zooms: [
      {
        id: "z1",
        startUs: 4100000,
        endUs: 8200000,
        rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        easeInUs: 400000,
        easeOutUs: 400000,
        easing: "easeInOutCubic",
        origin: "live",
      },
    ],
    cuts: [{ id: "c1", startUs: 20000000, endUs: 23500000 }],
    cursor: { hidden: false },
    clicks: { effect: "none" },
  },
});

describe("parseProject", () => {
  test("parses the design-doc example and round-trips", () => {
    const p = parseProject(example());
    const again = parseProject(JSON.parse(serializeProject(p)));
    expect(again).toEqual(p);
    expect(p.edits.zooms[0]?.origin).toBe("live");
  });

  test("preserves unknown fields", () => {
    const input = { ...example(), futureThing: { a: 1 } } as any;
    input.edits.layout = [];
    const out = JSON.parse(serializeProject(parseProject(input)));
    expect(out.futureThing).toEqual({ a: 1 });
    expect(out.edits.layout).toEqual([]);
  });

  test("rejects wrong version", () => {
    expect(() => parseProject({ ...example(), version: 2 })).toThrowError(/version/);
    expect(() => parseProject({ ...example(), version: 2 })).toThrowError(FormatError);
  });

  test("rejects missing screen track", () => {
    const input = example() as any;
    delete input.tracks.screen;
    expect(() => parseProject(input)).toThrowError(/tracks\.screen/);
  });

  test("accepts a project without mic", () => {
    const input = example() as any;
    delete input.tracks.mic;
    expect(parseProject(input).tracks.mic).toBeUndefined();
  });

  test("defaults zooms and cuts to empty arrays", () => {
    const input = example() as any;
    input.edits = {};
    const p = parseProject(input);
    expect(p.edits.zooms).toEqual([]);
    expect(p.edits.cuts).toEqual([]);
  });

  test("serialize ends with a newline and uses 2-space indent", () => {
    const s = serializeProject(parseProject(example()));
    expect(s.endsWith("}\n")).toBe(true);
    expect(s).toContain('\n  "version": 1');
  });
});

describe("parseProject with the Rust writer fixture", () => {
  test("parses the Rust project fixture", () => {
    const url = new URL("../../../crates/capture/tests/fixtures/project-sample.json", import.meta.url);
    const p = parseProject(JSON.parse(readFileSync(url, "utf8")));
    expect(p.source).toEqual({ width: 2560, height: 1440, fps: 60 });
    expect(p.output).toEqual({ width: 1920, height: 1080, fps: 60 });
    expect(p.tracks.mic).toEqual({ file: "mic.wav", offsetUs: 12400, volume: 1, muted: false });
    expect(p.zoomPresets).toEqual([{ id: "p1", name: "Preset p1", rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }]);
    expect(p.edits.zooms).toHaveLength(1);
    expect(p.edits.zooms[0]).toMatchObject({ id: "live-1", startUs: 4100000, endUs: 8200000, origin: "live", easing: "easeInOutCubic" });
    expect(p.edits.cuts).toEqual([]);
  });
});

describe("camera track", () => {
  const withCamera = () => {
    const e = example() as Record<string, any>;
    e.tracks.camera = { file: "camera.mp4", offsetUs: 41000, width: 1280, height: 720, fps: 30 };
    return e;
  };

  test("a project without a camera has no camera track and default camera edits", () => {
    const p = parseProject(example());
    expect(p.tracks.camera).toBeUndefined();
    expect(p.edits.camera).toBeUndefined();
    expect(cameraEdits(p)).toEqual(DEFAULT_CAMERA_EDITS);
    expect(serializeProject(p)).not.toContain('"camera"');
  });

  test("parses tracks.camera and edits.camera and round-trips with unknown fields", () => {
    const e = withCamera();
    e.edits.camera = {
      visible: false,
      mirror: false,
      pip: { corner: "topLeft", widthFrac: 0.3, marginFrac: 0.03, shape: "rect", future: 1 },
      scenes: [{ id: "s1", startUs: 0, endUs: 10, layout: "side" }],
      later: "kept",
    };
    const p = parseProject(e);
    expect(p.tracks.camera).toEqual({ file: "camera.mp4", offsetUs: 41000, width: 1280, height: 720, fps: 30 });
    expect(cameraEdits(p).pip.corner).toBe("topLeft");
    const again = JSON.parse(serializeProject(parseProject(JSON.parse(serializeProject(p)))));
    expect(again.edits.camera.later).toBe("kept");
    expect(again.edits.camera.pip.future).toBe(1);
    expect(again.edits.camera.scenes).toHaveLength(1);
  });

  test("missing scenes default to an empty list; a bad corner is refused", () => {
    const e = withCamera();
    e.edits.camera = { visible: true, mirror: true, pip: { corner: "bottomRight", widthFrac: 0.22, marginFrac: 0.03, shape: "rect" } };
    expect(parseProject(e).edits.camera?.scenes).toEqual([]);
    e.edits.camera.pip.corner = "middle";
    expect(() => parseProject(e)).toThrow(FormatError);
  });
});
