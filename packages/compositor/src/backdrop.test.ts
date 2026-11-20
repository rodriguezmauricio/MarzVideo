import { afterEach, describe, expect, it, vi } from "vitest";
import { BLUR_DARKEN, BLUR_DOWNSCALE, coverSource, paintBackdrop, sourceSize } from "./background";

const OUT = { width: 1920, height: 1080 };
const COLORS = { paper: "P", ink: "I", accent: "A" };

/** A 2D context that logs what it is asked to do. */
function fakeCtx(log: string[], name = "out") {
  const grad = (kind: string) => ({ addColorStop: (o: number, c: string) => log.push(`${name}:${kind}stop ${o} ${c}`) });
  return {
    save() {}, restore() {}, clearRect() {},
    set fillStyle(v: unknown) { log.push(`${name}:fill ${typeof v === "string" ? v : "gradient"}`); },
    set globalAlpha(v: number) { log.push(`${name}:alpha ${v}`); },
    set filter(v: string) { log.push(`${name}:filter ${v}`); },
    imageSmoothingEnabled: true, imageSmoothingQuality: "low",
    fillRect: (x: number, y: number, w: number, h: number) => log.push(`${name}:rect ${x},${y},${w},${h}`),
    createLinearGradient: (...a: number[]) => (log.push(`${name}:linear ${a.join(",")}`), grad("lin")),
    createRadialGradient: () => grad("rad"),
    drawImage: (src: { tag?: string }, ...a: number[]) => log.push(`${name}:img ${src.tag ?? "?"} ${a.map((n) => Math.round(n)).join(",")}`),
  } as unknown as CanvasRenderingContext2D;
}

/** A stand-in OffscreenCanvas: each one logs under its own name. */
function stubCanvas(log: string[]) {
  let n = 0;
  vi.stubGlobal("OffscreenCanvas", class {
    tag: string; width: number; height: number; c: CanvasRenderingContext2D;
    constructor(w: number, h: number) { this.width = w; this.height = h; this.tag = `c${n++}`; this.c = fakeCtx(log, this.tag); log.push(`new ${this.tag} ${w}x${h}`); }
    getContext() { return this.c; }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("paintBackdrop", () => {
  it("gradient: a diagonal between the pair's two token colours", () => {
    const log: string[] = [];
    paintBackdrop(fakeCtx(log), { style: "gradient", gradient: "paper-accent" }, OUT, COLORS);
    expect(log).toContain("out:linear 0,0,1920,1080");
    expect(log).toContain("out:linstop 0 P");
    expect(log).toContain("out:linstop 1 A");
  });

  it("image: cover-fitted once into a cached canvas the size of the output, then drawn whole", () => {
    const log: string[] = [];
    stubCanvas(log);
    const image = { tag: "photo", naturalWidth: 4000, naturalHeight: 4000 } as unknown as CanvasImageSource;
    paintBackdrop(fakeCtx(log), { style: "image", gradient: "ink-accent" }, OUT, COLORS, { image });
    paintBackdrop(fakeCtx(log), { style: "image", gradient: "ink-accent" }, OUT, COLORS, { image });
    expect(log.filter((l) => l.startsWith("new"))).toEqual(["new c0 1920x1080"]);
    // Square photo into 16:9: the full width, a centred band of 2250 px.
    expect(log).toContain("c0:img photo 0,875,4000,2250,0,0,1920,1080");
    expect(log.filter((l) => l === "out:img c0 0,0,1920,1080")).toHaveLength(2);
  });

  it("image or blur without a picture: plain ink", () => {
    const log: string[] = [];
    paintBackdrop(fakeCtx(log), { style: "image", gradient: "ink-accent" }, OUT, COLORS, {});
    paintBackdrop(fakeCtx(log), { style: "blur", gradient: "ink-accent" }, OUT, COLORS, { screen: null });
    expect(log.filter((l) => l.includes("img"))).toEqual([]);
    expect(log.filter((l) => l === "out:fill I")).toHaveLength(2);
  });

  it("blur: the screen blurred on a small canvas, scaled up over the output, darkened with ink", () => {
    const log: string[] = [];
    stubCanvas(log);
    const screen = { tag: "screen", videoWidth: 1920, videoHeight: 1080 } as unknown as CanvasImageSource;
    paintBackdrop(fakeCtx(log), { style: "blur", gradient: "ink-accent" }, OUT, COLORS, { screen });
    const sw = 1920 / BLUR_DOWNSCALE;
    const sh = 1080 / BLUR_DOWNSCALE;
    expect(log.find((l) => l.startsWith("new"))).toBe(`new c0 ${sw + 12}x${sh + 12}`);
    expect(log).toContain("c0:filter blur(2px)");
    expect(log.some((l) => l.startsWith("c0:img screen"))).toBe(true);
    expect(log).toContain(`out:img c0 6,6,${sw},${sh},0,0,1920,1080`);
    expect(log.slice(-3)).toEqual([`out:alpha ${BLUR_DARKEN}`, "out:fill I", "out:rect 0,0,1920,1080"]);
  });
});

describe("cover helpers", () => {
  it("reads sizes of images, videos and frames", () => {
    expect(sourceSize({ naturalWidth: 10, naturalHeight: 5 } as unknown as CanvasImageSource)).toEqual({ width: 10, height: 5 });
    expect(sourceSize({ displayWidth: 8, displayHeight: 4 } as unknown as CanvasImageSource)).toEqual({ width: 8, height: 4 });
    expect(sourceSize({ videoWidth: 0, videoHeight: 0 } as unknown as CanvasImageSource)).toBeNull();
  });
  it("crops the centre without stretching", () => {
    expect(coverSource({ width: 1920, height: 1080 }, 1080, 1920)).toEqual({ sx: 656.25, sy: 0, sw: 607.5, sh: 1080 });
  });
});
