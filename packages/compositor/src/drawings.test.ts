import { describe, expect, test } from "vitest";
import { parseProject, type Stroke } from "@marz/format";
import { drawStrokes, strokesAt, STROKE_FADE_US } from "./drawings";
import { drawFrame } from "./draw";
import { frameAt } from "./frame";

const pen: Stroke = { id: "s1", startUs: 1_000_000, endUs: 3_000_000, tool: "pen", color: "rec", width: 6, points: [[100, 100], [200, 100]], origin: "live" };
const project = (strokes: unknown[], zooms: unknown[] = []) =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-19T00:00:00Z", durationUs: 20_000_000,
    source: { width: 1920, height: 1080, fps: 60 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 60 },
    edits: { zooms, cuts: [], drawings: { strokes } },
  });
const colors = { accent: "A", rec: "R", paper: "P", ink: "I" };

/** A fake 2D context that records calls and the style at each stroke/fill. */
function fakeCtx() {
  const calls: unknown[][] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        if (k === "stroke" || k === "fill" || k === "fillText") calls.push([k, ...a, { lw: t.lineWidth, alpha: t.globalAlpha, color: k === "stroke" ? t.strokeStyle : t.fillStyle, font: t.font }]);
        else calls.push([k, ...a]);
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("strokesAt", () => {
  test("visible between start and end with a fade in and out", () => {
    const p = project([pen]);
    expect(strokesAt(p, 999_999)).toEqual([]);
    expect(strokesAt(p, 1_000_000)[0]!.alpha).toBe(0);
    expect(strokesAt(p, 1_000_000 + STROKE_FADE_US / 2)[0]!.alpha).toBeCloseTo(0.5);
    expect(strokesAt(p, 2_000_000)[0]!.alpha).toBe(1);
    expect(strokesAt(p, 3_000_000 - STROKE_FADE_US / 2)[0]!.alpha).toBeCloseTo(0.5);
    expect(strokesAt(p, 3_000_000)).toEqual([]);
  });

  test("a short stroke fades over half its length", () => {
    const p = project([{ ...pen, endUs: 1_200_000 }]);
    expect(strokesAt(p, 1_100_000)[0]!.alpha).toBe(1);
  });
});

describe("drawStrokes", () => {
  const ident = { srcRect: { sx: 0, sy: 0, sw: 1920, sh: 1080 }, dstRect: { dx: 0, dy: 0, dw: 1920, dh: 1080 } };

  test("maps source pixels through the frame and clips to the picture", () => {
    const { ctx, calls } = fakeCtx();
    // A 2x zoom on the top-left quarter, drawn into a box at (100, 0).
    drawStrokes(ctx, [{ stroke: pen, alpha: 1 }], { srcRect: { sx: 0, sy: 0, sw: 960, sh: 540 }, dstRect: { dx: 100, dy: 0, dw: 1920, dh: 1080 } }, colors, "F");
    expect(calls).toContainEqual(["rect", 100, 0, 1920, 1080]);
    expect(calls).toContainEqual(["moveTo", 300, 200]);
    expect(calls).toContainEqual(["lineTo", 500, 200]);
    expect(calls.find((c) => c[0] === "stroke")!.at(-1)).toEqual({ lw: 12, alpha: 1, color: "R", font: undefined });
  });

  test("highlighter is 4x wide at 40% of the stroke's opacity", () => {
    const { ctx, calls } = fakeCtx();
    drawStrokes(ctx, [{ stroke: { ...pen, tool: "highlighter" }, alpha: 0.5 }], ident, colors, "F");
    expect(calls.find((c) => c[0] === "stroke")!.at(-1)).toMatchObject({ lw: 24, alpha: 0.2 });
  });

  test("arrow, rect, ellipse and text", () => {
    const { ctx, calls } = fakeCtx();
    drawStrokes(
      ctx,
      [
        { stroke: { ...pen, tool: "arrow", points: [[0, 0], [100, 0]] }, alpha: 1 },
        { stroke: { ...pen, tool: "rect", points: [[50, 60], [10, 20]] }, alpha: 1 },
        { stroke: { ...pen, tool: "ellipse", points: [[0, 0], [100, 50]] }, alpha: 1 },
        { stroke: { ...pen, tool: "text", text: "Here", points: [[7, 8]] }, alpha: 1 },
      ],
      ident,
      colors,
      "Grotesk",
    );
    // Arrow head ends at the tip.
    expect(calls.filter((c) => c[0] === "lineTo" && c[1] === 100 && c[2] === 0)).toHaveLength(2);
    expect(calls).toContainEqual(["rect", 10, 20, 40, 40]);
    expect(calls).toContainEqual(["ellipse", 50, 25, 50, 25, 0, 0, Math.PI * 2]);
    const text = calls.find((c) => c[0] === "fillText")!;
    expect(text.slice(0, 4)).toEqual(["fillText", "Here", 7, 8]);
    expect(text.at(-1)).toMatchObject({ font: "700 48px Grotesk", color: "R" });
  });

  test("an unknown colour name falls back to accent; nothing visible draws nothing", () => {
    const { ctx, calls } = fakeCtx();
    drawStrokes(ctx, [], ident, colors, "F");
    expect(calls).toEqual([]);
    drawStrokes(ctx, [{ stroke: { ...pen, color: "x" as never }, alpha: 1 }], ident, colors, "F");
    expect(calls.find((c) => c[0] === "stroke")!.at(-1)).toMatchObject({ color: "A" });
  });
});

describe("drawFrame with strokes", () => {
  test("strokes follow the zoom: drawn after the picture, before the cursor", () => {
    const p = project([pen], [
      { id: "z", startUs: 0, endUs: 10_000_000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, easeInUs: 0, easeOutUs: 0, easing: "linear", origin: "manual" },
    ]);
    const spec = frameAt(p, [{ tUs: 0, type: "cursor", x: 10, y: 10 }], 2_000_000);
    const { ctx, calls } = fakeCtx();
    drawFrame(ctx, {} as CanvasImageSource, spec, p.output, null, undefined, { items: strokesAt(p, 2_000_000), colors, family: "F" });
    const names = calls.map((c) => c[0]);
    expect(names.indexOf("drawImage")).toBeLessThan(names.indexOf("stroke"));
    expect(calls).toContainEqual(["moveTo", 200, 200]);
    expect(names.lastIndexOf("fill")).toBeGreaterThan(names.indexOf("stroke"));
  });
});
