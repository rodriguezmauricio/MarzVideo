import { describe, expect, test } from "vitest";
import { cameraScenes, cameraTransitions, customMask, DEFAULT_TRANSITION, parseProject, serializeProject, transitionFor } from "./project";
import { parseEvents } from "./events";

const base = (camera?: object) => ({
  version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
  source: { width: 1920, height: 1080, fps: 60 },
  tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } },
  output: { width: 1920, height: 1080, fps: 60 },
  edits: { zooms: [], cuts: [], ...(camera ? { camera } : {}) },
});
const pip = { corner: "bottomRight", widthFrac: 0.22, marginFrac: 0.03, shape: "star" };
const cam = (extra: object) => base({ visible: true, mirror: true, pip, scenes: [], ...extra });

describe("camera extras in project.json", () => {
  test("float is a known layout", () => {
    const p = parseProject(cam({ scenes: [{ id: "l1", startUs: 0, endUs: 1_000_000, layout: "float", origin: "manual" }] }));
    expect(cameraScenes(p)[0]!.layout).toBe("float");
  });

  test("no transitions: the default switch for every pair", () => {
    const p = parseProject(cam({}));
    expect(cameraTransitions(p)).toEqual([]);
    expect(transitionFor(p, "pip", "side")).toEqual(DEFAULT_TRANSITION);
    expect(DEFAULT_TRANSITION).toEqual({ durationUs: 400_000, easing: "easeInOutCubic", morph: "blend" });
  });

  test("reads a transition per pair, the later entry wins", () => {
    const p = parseProject(
      cam({
        transitions: [
          { from: "pip", to: "side", durationUs: 800_000, easing: "linear", morph: "blend" },
          { from: "pip", to: "side", durationUs: 1_200_000, easing: "easeOutCubic", morph: "end", path: { c1: [0.3, -0.5], c2: [0.7, -0.5] } },
        ],
      }),
    );
    expect(transitionFor(p, "pip", "side")).toEqual({ durationUs: 1_200_000, easing: "easeOutCubic", morph: "end", path: { c1: [0.3, -0.5], c2: [0.7, -0.5] } });
    expect(transitionFor(p, "side", "pip")).toEqual(DEFAULT_TRANSITION);
  });

  test("unknown easing and morph read as defaults and are written back; broken entries are kept but ignored", () => {
    const raw = cam({
      transitions: [
        { from: "pip", to: "camera", durationUs: 800_000, easing: "bounce", morph: "spiral" },
        { from: "pip", to: "nowhere", durationUs: 800_000, easing: "linear", morph: "blend" },
        { from: "pip", to: "side", durationUs: 99, easing: "linear", morph: "blend" },
      ],
    });
    const p = parseProject(raw);
    expect(transitionFor(p, "pip", "camera")).toEqual({ durationUs: 800_000, easing: "easeInOutCubic", morph: "blend" });
    expect(transitionFor(p, "pip", "side")).toEqual(DEFAULT_TRANSITION);
    const out = JSON.parse(serializeProject(p));
    expect(out.edits.camera.transitions[0].easing).toBe("bounce");
    expect(out.edits.camera.transitions[0].morph).toBe("spiral");
    expect(out.edits.camera.transitions[1].to).toBe("nowhere");
    expect(out.edits.camera.transitions[2].durationUs).toBe(99);
  });

  test("custom mask: points in the unit box, 3 to 512 points", () => {
    const ok = parseProject(cam({ customMask: { name: "tri.svg", points: [0.5, 0, 1, 1, 0, 1] } }));
    expect(customMask(ok)).toEqual({ name: "tri.svg", points: [0.5, 0, 1, 1, 0, 1] });
    expect(customMask(parseProject(cam({ customMask: { name: "x", points: [0, 0, 1, 1] } })))).toBeNull();
    expect(customMask(parseProject(cam({ customMask: { name: "x", points: [0, 0, 2, 1, 0, 1] } })))).toBeNull();
    expect(customMask(parseProject(cam({ customMask: { name: "x", points: [0, 0, 1, 1, 0] } })))).toBeNull();
    expect(customMask(parseProject(cam({})))).toBeNull();
  });

  test("events: a float layout press", () => {
    const evs = parseEvents('{"type":"header","version":1,"source":{"width":1920,"height":1080,"fps":60},"startedAt":"x"}\n{"tUs":5,"type":"layout","layout":"float"}\n');
    expect(evs.events.some((e) => e.type === "layout" && e.layout === "float")).toBe(true);
  });
});
