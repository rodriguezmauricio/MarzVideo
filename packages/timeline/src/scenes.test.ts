import { cameraBorder, cameraEdits, cameraScenes, parseProject, type MarzEvent, type Project, type Scene } from "@marz/format";
import { describe, expect, test } from "vitest";
import { addScene, importLiveLayouts, removeScene, updateScene } from "./scenes";
import { updateCamera } from "./commands";
import { History } from "./history";

const S = 1_000_000;
const base = (camera = true, edits: object = {}): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 60 * S,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, ...(camera ? { camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } } : {}) },
    output: { width: 1920, height: 1080, fps: 30 },
    edits: { zooms: [], cuts: [], ...edits },
  });
const sc = (id: string, a: number, b: number, layout: Scene["layout"] = "side", origin: Scene["origin"] = "manual"): Scene => ({ id, startUs: a * S, endUs: b * S, layout, origin });
const ids = (p: Project) => cameraScenes(p).map((s) => `${s.id}:${s.startUs / S}-${s.endUs / S}`);

describe("addScene", () => {
  test("adds a scene and writes the camera defaults around it", () => {
    const p = addScene(sc("a", 2, 5))(base());
    expect(ids(p)).toEqual(["a:2-5"]);
    expect(cameraEdits(p).visible).toBe(true);
  });
  test("is trimmed to the free space after its start", () => {
    const p = addScene(sc("b", 4, 9))(addScene(sc("a", 6, 8))(base()));
    expect(ids(p)).toEqual(["b:4-6", "a:6-8"]);
  });
  test("starting inside another scene: starts at its end", () => {
    const p = addScene(sc("b", 3, 9))(addScene(sc("a", 2, 5))(base()));
    expect(ids(p)).toEqual(["a:2-5", "b:5-9"]);
  });
  test("no room: nothing changes", () => {
    const one = addScene(sc("a", 0, 60))(base());
    expect(addScene(sc("b", 10, 12))(one)).toBe(one);
  });
  test("kept inside the video", () => {
    expect(ids(addScene(sc("a", 58, 63))(base()))).toEqual(["a:58-60"]);
  });
});

describe("updateScene", () => {
  const two = () => addScene(sc("b", 10, 15))(addScene(sc("a", 2, 5, "camera", "live"))(base()));
  test("moves within its neighbours", () => {
    expect(ids(updateScene("a", { startUs: 8 * S, endUs: 12 * S })(two()))).toEqual(["a:8-10", "b:10-15"]);
  });
  test("a move keeps the length and stops at the neighbour", () => {
    expect(ids(updateScene("a", { startUs: 7 * S, endUs: 10 * S })(two()))).toEqual(["a:7-10", "b:10-15"]);
    expect(ids(updateScene("a", { startUs: 9 * S, endUs: 12 * S })(two()))).toEqual(["a:7-10", "b:10-15"]);
  });
  test("a live scene becomes manual when its time changes, not when its layout changes", () => {
    expect(cameraScenes(updateScene("a", { layout: "screen" })(two()))[0]!.origin).toBe("live");
    expect(cameraScenes(updateScene("a", { endUs: 6 * S })(two()))[0]!.origin).toBe("manual");
  });
  test("same values: the same project", () => {
    const p = two();
    expect(updateScene("a", { startUs: 2 * S, layout: "camera" })(p)).toBe(p);
    expect(updateScene("zz", { startUs: 1 })(p)).toBe(p);
  });
  test("keeps a minimum length", () => {
    const p = updateScene("a", { endUs: 2 * S })(two());
    const a = cameraScenes(p)[0]!;
    expect(a.endUs - a.startUs).toBeGreaterThanOrEqual(100_000);
  });
});

describe("removeScene", () => {
  test("removes it; unknown id is a no-op", () => {
    const p = addScene(sc("a", 2, 5))(base());
    expect(ids(removeScene("a")(p))).toEqual([]);
    expect(removeScene("x")(p)).toBe(p);
  });
  test("one undo step each", () => {
    const h = new History(base());
    h.apply(addScene(sc("a", 2, 5)));
    h.apply(updateScene("a", { endUs: 7 * S }));
    h.apply(removeScene("a"));
    h.undo();
    expect(ids(h.current)).toEqual(["a:2-7"]);
    h.undo();
    expect(ids(h.current)).toEqual(["a:2-5"]);
  });
});

describe("importLiveLayouts", () => {
  const ev = (tUs: number, layout: "pip" | "side" | "camera" | "screen"): MarzEvent => ({ type: "layout", tUs, layout });
  test("each press starts a scene until the next press or the end; pip presses only end one", () => {
    const p = importLiveLayouts([ev(2 * S, "side"), ev(5 * S, "camera"), ev(8 * S, "pip"), ev(20 * S, "screen")])(base());
    expect(cameraScenes(p).map((s) => [s.layout, s.startUs / S, s.endUs / S, s.origin])).toEqual([
      ["side", 2, 5, "live"],
      ["camera", 5, 8, "live"],
      ["screen", 20, 60, "live"],
    ]);
    expect(cameraEdits(p).liveImported).toBe(true);
  });
  test("only once: after import (or a deleted scene) nothing comes back", () => {
    const once = importLiveLayouts([ev(2 * S, "side")])(base());
    const deleted = removeScene(cameraScenes(once)[0]!.id)(once);
    expect(importLiveLayouts([ev(2 * S, "side")])(deleted)).toBe(deleted);
  });
  test("no camera or no presses: unchanged", () => {
    const noCam = base(false);
    expect(importLiveLayouts([ev(2 * S, "side")])(noCam)).toBe(noCam);
    const p = base();
    expect(importLiveLayouts([])(p)).toBe(p);
  });
  test("presses past the end and repeats are ignored", () => {
    const p = importLiveLayouts([ev(2 * S, "side"), ev(3 * S, "side"), ev(70 * S, "camera")])(base());
    expect(cameraScenes(p).map((s) => [s.layout, s.startUs / S, s.endUs / S])).toEqual([["side", 2, 60]]);
  });
});

describe("updateCamera shape and border", () => {
  test("shape and border are one step each and no-ops when the same", () => {
    const p = updateCamera({ pip: { shape: "circle" } })(base());
    expect(cameraEdits(p).pip.shape).toBe("circle");
    expect(updateCamera({ pip: { shape: "circle" } })(p)).toBe(p);
    const q = updateCamera({ border: { width: 4, color: "accent" } })(p);
    expect(cameraBorder(q)).toEqual({ width: 4, color: "accent" });
    expect(updateCamera({ border: { width: 4, color: "accent" } })(q)).toBe(q);
    expect(cameraEdits(updateCamera({ border: { color: "ink" } })(q)).border).toEqual({ width: 4, color: "ink" });
  });
  test("keeps the scenes", () => {
    const p = updateCamera({ mirror: false })(addScene(sc("a", 2, 5))(base()));
    expect(ids(p)).toEqual(["a:2-5"]);
  });
});
