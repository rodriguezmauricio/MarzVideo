import { describe, expect, test } from "vitest";
import { drawCamera, drawFrame } from "./draw";
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

describe("drawCamera with an outline mask", () => {
  test("clips to the outline scaled into the box and strokes the border along it, double width (inner half shows)", () => {
    const log: string[] = [];
    const ctx = {
      save: () => log.push("save"),
      restore: () => log.push("restore"),
      beginPath: () => log.push("begin"),
      moveTo: (x: number, y: number) => log.push(`M${x},${y}`),
      lineTo: (x: number, y: number) => log.push(`L${x},${y}`),
      closePath: () => log.push("Z"),
      clip: () => log.push("clip"),
      stroke: () => log.push("stroke"),
      drawImage: () => log.push("img"),
      fillRect: () => log.push("rect"),
      translate() {},
      scale() {},
      set lineWidth(v: number) { log.push(`lw${v}`); },
      set strokeStyle(_v: string) {},
      set fillStyle(_v: string) {},
    } as unknown as CanvasRenderingContext2D;
    drawCamera(ctx, {
      source: {} as CanvasImageSource,
      srcSize: { width: 1280, height: 720 },
      rect: { x: 100, y: 200, w: 300, h: 300 },
      mirror: false,
      mask: [0.5, 0, 1, 1, 0, 1],
      border: { width: 4, color: "#fff" },
    });
    expect(log.slice(0, 7)).toEqual(["save", "begin", "M250,200", "L400,500", "L100,500", "Z", "clip"]);
    expect(log).toContain("img");
    expect(log).toContain("lw8");
    expect(log).toContain("stroke");
    expect(log).not.toContain("rect");
  });
});
