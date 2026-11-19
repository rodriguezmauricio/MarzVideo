import { describe, expect, test } from "vitest";
import { drawFrame } from "./draw";
import type { FrameSpec } from "./frame";

/** A context that records drawImage arguments. */
function recorder() {
  const calls: unknown[][] = [];
  const ctx = { fillStyle: "", fillRect() {}, drawImage: (...a: unknown[]) => calls.push(a) };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const spec = (sourceSize?: { width: number; height: number }): FrameSpec => ({
  srcRect: { sx: 480, sy: 270, sw: 960, sh: 540 },
  dstRect: { dx: 0, dy: 0, dw: 1920, dh: 1080 },
  cursor: null,
  clicks: [],
  sourceSize,
});
const out = { width: 1920, height: 1080 };

describe("drawFrame", () => {
  test("crops in the media's own pixels when the file is smaller than project.source (a proxy)", () => {
    const { ctx, calls } = recorder();
    const video = { videoWidth: 960, videoHeight: 540 } as unknown as CanvasImageSource;
    drawFrame(ctx, video, spec({ width: 1920, height: 1080 }), out);
    expect(calls[0]!.slice(1, 5)).toEqual([240, 135, 480, 270]);
  });

  test("a frame of the source's size is cropped as given", () => {
    const { ctx, calls } = recorder();
    const frame = { displayWidth: 1920, displayHeight: 1080 } as unknown as CanvasImageSource;
    drawFrame(ctx, frame, spec({ width: 1920, height: 1080 }), out);
    expect(calls[0]!.slice(1, 5)).toEqual([480, 270, 960, 540]);
  });

  test("a media size that cannot be read (not loaded yet) leaves the crop as given", () => {
    const { ctx, calls } = recorder();
    drawFrame(ctx, { videoWidth: 0, videoHeight: 0 } as unknown as CanvasImageSource, spec({ width: 1920, height: 1080 }), out);
    expect(calls[0]!.slice(1, 5)).toEqual([480, 270, 960, 540]);
  });
});
