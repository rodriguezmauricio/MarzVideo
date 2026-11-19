import { describe, expect, test } from "vitest";
import { cameraTransitions, customMask, DEFAULT_TRANSITION, parseProject, transitionFor } from "@marz/format";
import { setCustomMask, setTransition } from "./cameraExtras";

const project = (camera?: object) =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } },
    output: { width: 1920, height: 1080, fps: 60 },
    edits: { zooms: [], cuts: [], ...(camera ? { camera } : {}) },
  });

describe("switch presets", () => {
  test("sets one pair, starting from the default, then patches it", () => {
    const p1 = setTransition("pip", "side", { durationUs: 800_000 })(project());
    expect(transitionFor(p1, "pip", "side")).toEqual({ ...DEFAULT_TRANSITION, durationUs: 800_000 });
    const p2 = setTransition("pip", "side", { path: { c1: [0.3, -0.4], c2: [0.7, -0.4] } })(p1);
    expect(transitionFor(p2, "pip", "side").path).toEqual({ c1: [0.3, -0.4], c2: [0.7, -0.4] });
    expect(cameraTransitions(p2)).toHaveLength(1);
    expect(transitionFor(p2, "side", "pip")).toEqual(DEFAULT_TRANSITION);
  });

  test("path null makes it straight; no change returns the same project", () => {
    const p1 = setTransition("pip", "side", { path: { c1: [0.3, -0.4], c2: [0.7, -0.4] } })(project());
    const p2 = setTransition("pip", "side", { path: null })(p1);
    expect(transitionFor(p2, "pip", "side").path).toBeUndefined();
    expect(setTransition("pip", "side", { durationUs: 400_000 })(p2)).toBe(p2);
  });

  test("keeps entries this build cannot read", () => {
    const p = project({ visible: true, mirror: true, pip: { corner: "bottomRight", widthFrac: 0.22, marginFrac: 0.03, shape: "rect" }, scenes: [], transitions: [{ from: "pip", to: "warp", durationUs: 1 }] });
    const next = setTransition("pip", "camera", { easing: "linear" })(p);
    expect(next.edits.camera!.transitions).toHaveLength(2);
  });
});

describe("custom mask", () => {
  test("stores the outline and picks the custom shape; same outline returns the same project", () => {
    const p = setCustomMask({ name: "tri.svg", points: [0.5, 0, 1, 1, 0, 1] })(project());
    expect(customMask(p)).toEqual({ name: "tri.svg", points: [0.5, 0, 1, 1, 0, 1] });
    expect(p.edits.camera!.pip.shape).toBe("custom");
    expect(setCustomMask({ name: "tri.svg", points: [0.5, 0, 1, 1, 0, 1] })(p)).toBe(p);
  });
});
