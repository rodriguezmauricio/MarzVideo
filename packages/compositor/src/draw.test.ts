import { describe, expect, test } from "vitest";
import { drawFrame, srcScaleFor } from "./draw";
import type { FrameSpec } from "./frame";

function fakeCtx() {
  const calls: unknown[][] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => void calls.push([k, ...a])),
    set: (t, k: string, v) => ((t[k] = v), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const spec = { srcRect: { sx: 480, sy: 270, sw: 960, sh: 540 }, dstRect: { dx: 0, dy: 0, dw: 1920, dh: 1080 }, clicks: [], cursor: null } as unknown as FrameSpec;

describe("drawFrame source scale (proxies)", () => {
  test("the source crop is in source pixels by default", () => {
    const { ctx, calls } = fakeCtx();
    drawFrame(ctx, {} as CanvasImageSource, spec, { width: 1920, height: 1080 });
    expect(calls.find((c) => c[0] === "drawImage")!.slice(2)).toEqual([480, 270, 960, 540, 0, 0, 1920, 1080]);
  });

  test("a 720p proxy of a 1080p source scales the crop, not the output", () => {
    const { ctx, calls } = fakeCtx();
    drawFrame(ctx, {} as CanvasImageSource, spec, { width: 1920, height: 1080 }, null, undefined, null, srcScaleFor(1280, 1920));
    expect(calls.find((c) => c[0] === "drawImage")!.slice(2)).toEqual([320, 180, 640, 360, 0, 0, 1920, 1080]);
  });
});

describe("srcScaleFor", () => {
  test("1 for the raw file, the width ratio for a proxy, 1 when a size is unknown", () => {
    expect(srcScaleFor(1918, 1918)).toBe(1);
    expect(srcScaleFor(1280, 1920)).toBeCloseTo(2 / 3);
    expect(srcScaleFor(0, 1920)).toBe(1);
    expect(srcScaleFor(1280, 0)).toBe(1);
  });
});
