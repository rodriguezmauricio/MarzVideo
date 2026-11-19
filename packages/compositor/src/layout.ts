import { cameraBorder, cameraEdits, cameraScenes, type LayoutKind, type Pip, type Project, type Scene } from "@marz/format";
import { pipRect, type Box } from "./camera";

/** Where the screen and the camera go on the editor frame, and the camera's corner radius (px). */
export type LayoutState = { screen: Box; camera: Box | null; radius: number };

type Size = { width: number; height: number };

/** How long a layout switch takes, from the scene boundary. */
export const LAYOUT_SWITCH_US = 400_000;
/** Rounded mask: corner radius as a share of the short side. */
const ROUNDED_FRAC = 0.18;
/** Circle and square masks: side as a share of the bubble width. */
const SQUARE_FRAC = 0.75;

const isRight = (pip: Pip) => pip.corner === "topRight" || pip.corner === "bottomRight";
const isBottom = (pip: Pip) => pip.corner === "bottomLeft" || pip.corner === "bottomRight";

/** A box moved to the pip's free position (`x`, `y` shares of the frame), kept inside the frame. */
function placed(box: Box, out: Size, pip: Pip): Box {
  if (pip.x === undefined || pip.y === undefined) return box;
  const x = Math.min(Math.max(0, Math.round(pip.x * out.width)), Math.max(0, out.width - box.w));
  const y = Math.min(Math.max(0, Math.round(pip.y * out.height)), Math.max(0, out.height - box.h));
  return { ...box, x, y };
}

/** Whether a pip shape draws a square box (centre cropped). */
export const isSquareShape = (shape: string) => shape === "circle" || shape === "square";

/** The corner bubble's box and radius for the pip's shape: in its corner, or at its free position. */
export function bubbleBox(out: Size, cam: Size, pip: Pip): { box: Box; radius: number } {
  if (isSquareShape(pip.shape)) {
    const side = Math.round(out.width * pip.widthFrac * SQUARE_FRAC);
    const m = Math.round(out.width * pip.marginFrac);
    const box = placed({ x: isRight(pip) ? out.width - m - side : m, y: isBottom(pip) ? out.height - m - side : m, w: side, h: side }, out, pip);
    return { box, radius: pip.shape === "circle" ? side / 2 : 0 };
  }
  const box = placed(pipRect(out, cam, pip), out, pip);
  return { box, radius: pip.shape === "rounded" ? Math.round(Math.min(box.w, box.h) * ROUNDED_FRAC) : 0 };
}

/** Circle and square masks: side as a share of the bubble width. */
export const BUBBLE_SQUARE_FRAC = SQUARE_FRAC;

/** Side column panel: full height, 9:16 wide, on the corner's side. */
const sideWidth = (out: Size) => Math.round((out.height * 9) / 16);

/** A layout at rest. */
export function staticLayout(kind: LayoutKind, out: Size, cam: Size, pip: Pip): LayoutState {
  const full = { x: 0, y: 0, w: out.width, h: out.height };
  switch (kind) {
    case "pip": {
      const b = bubbleBox(out, cam, pip);
      return { screen: full, camera: b.box, radius: b.radius };
    }
    case "side": {
      const w = sideWidth(out);
      const right = isRight(pip);
      return {
        screen: { x: right ? 0 : w, y: 0, w: out.width - w, h: out.height },
        camera: { x: right ? out.width - w : 0, y: 0, w, h: out.height },
        radius: 0,
      };
    }
    case "camera":
      return { screen: full, camera: { ...full }, radius: 0 };
    default:
      return { screen: full, camera: null, radius: 0 };
  }
}

/** Where a layout's camera comes from when it appears (and goes when it leaves): the side column
 *  slides from its edge, the others grow from the centre of their box. */
function hiddenCamera(kind: LayoutKind, at: Box, out: Size, pip: Pip): Box {
  if (kind === "side") return { ...at, x: isRight(pip) ? out.width : -at.w };
  return { x: at.x + at.w / 2, y: at.y + at.h / 2, w: 0, h: 0 };
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const lerpBox = (a: Box, b: Box, p: number): Box => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) });
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** The layout in force at `t` (no switch): the later-starting scene that covers it, else the bubble. */
function kindAt(scenes: Scene[], t: number): LayoutKind {
  let k: LayoutKind = "pip";
  for (const s of scenes) {
    if (s.startUs > t) break;
    if (t < s.endUs) k = s.layout;
  }
  return k;
}

/** The camera and screen boxes at source time `srcUs` on a frame of size `out`, switches included.
 *  Shared by preview and export. `statics` gives other boxes for each layout at rest (the vertical
 *  picture); with it a camera that appears or leaves always grows from or shrinks to its centre. */
export function layoutAt(project: Project, srcUs: number, out: Size, statics?: (kind: LayoutKind) => LayoutState): LayoutState {
  const cam = project.tracks.camera;
  const full = { x: 0, y: 0, w: out.width, h: out.height };
  if (!cam) return { screen: full, camera: null, radius: 0 };
  const edits = cameraEdits(project);
  if (!edits.visible) return { screen: full, camera: null, radius: 0 };
  const scenes = cameraScenes(project);
  const pip = edits.pip;
  const bounds = [...new Set(scenes.flatMap((s) => [s.startUs, s.endUs]))].filter((b) => b > 0).sort((a, b) => b - a);

  // `before`: only boundaries strictly before it count (the state just before a switch at `before`).
  const state = (t: number, kind: LayoutKind, before: number, depth: number): LayoutState => {
    const to = statics ? statics(kind) : staticLayout(kind, out, cam, pip);
    if (depth > 8) return to;
    for (const c of bounds) {
      if (c > t || c >= before) continue;
      if (c <= t - LAYOUT_SWITCH_US) break;
      const prev = kindAt(scenes, c - 1);
      if (prev === kindAt(scenes, c)) continue;
      const from = state(c, prev, c, depth + 1);
      return mix(from, to, kind, easeInOutCubic((t - c) / LAYOUT_SWITCH_US), out, pip, !statics);
    }
    return to;
  };
  return state(srcUs, kindAt(scenes, srcUs), Infinity, 0);
}

/** `from` at p = 0 to `to` (a layout of kind `toKind`) at p = 1. */
function mix(from: LayoutState, to: LayoutState, toKind: LayoutKind, p: number, out: Size, pip: Pip, slide = true): LayoutState {
  const screen = lerpBox(from.screen, to.screen, p);
  if (p >= 1) return to;
  if (from.camera && to.camera) return { screen, camera: lerpBox(from.camera, to.camera, p), radius: lerp(from.radius, to.radius, p) };
  if (to.camera) return { screen, camera: lerpBox(hiddenCamera(slide ? toKind : "pip", to.camera, out, pip), to.camera, p), radius: toKind === "side" ? to.radius : to.radius * p };
  if (from.camera) {
    // Leaving: the side column slides out to its edge, the rest shrink to their centre.
    const slides = slide && from.camera.h === out.height && from.camera.w === sideWidth(out) && (from.camera.x === 0 || from.camera.x === out.width - from.camera.w);
    const gone = slides ? hiddenCamera("side", from.camera, out, pip) : hiddenCamera("pip", from.camera, out, pip);
    return { screen, camera: lerpBox(from.camera, gone, p), radius: from.radius * (1 - p) };
  }
  return { screen, camera: null, radius: 0 };
}

/** The part of a `cam` picture that fills `box` without stretching (cover), around its centre. */
export function coverCrop(cam: Size, box: Box): { sx: number; sy: number; sw: number; sh: number } {
  if (box.w <= 0 || box.h <= 0) return { sx: 0, sy: 0, sw: cam.width, sh: cam.height };
  const boxAr = box.w / box.h;
  if (cam.width * box.h === cam.height * box.w) return { sx: 0, sy: 0, sw: cam.width, sh: cam.height };
  if (cam.width / cam.height > boxAr) {
    const sw = cam.height * boxAr;
    return { sx: (cam.width - sw) / 2, sy: 0, sw, sh: cam.height };
  }
  const sh = cam.width / boxAr;
  return { sx: 0, sy: (cam.height - sh) / 2, sw: cam.width, sh };
}

/** The camera layer for a layout state: border width in output pixels and colour from `colors`
 *  (the design tokens, read by the caller at run time). Null when the layout shows no camera. */
export function cameraLayerFor<S>(
  project: Project,
  state: LayoutState,
  out: Size,
  source: S,
  srcSize: Size,
  colors: Record<"paper" | "ink" | "accent", string>,
): { source: S; srcSize: Size; rect: Box; radius: number; mirror: boolean; border: { width: number; color: string } } | null {
  if (!state.camera) return null;
  const b = cameraBorder(project);
  const width = b.width <= 0 ? 0 : Math.max(1, Math.round((b.width * out.height) / 1080));
  return { source, srcSize, rect: state.camera, radius: state.radius, mirror: cameraEdits(project).mirror, border: { width, color: colors[b.color] } };
}
