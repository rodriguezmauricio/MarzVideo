import {
  cameraBorder,
  cameraEdits,
  cameraScenes,
  cameraTransitions,
  customMask,
  DEFAULT_TRANSITION,
  transitionFor,
  type LayoutKind,
  type Pip,
  type Project,
  type Scene,
  type SwitchSpec,
  type TransitionEasing,
} from "@marz/format";
import { pipRect, type Box } from "./camera";
import { lerpPolygon, MORPH_POINTS, resamplePolygon, roundRectPolygon, starPolygon } from "./masks";

/** Where the screen and the camera go on the editor frame, and the camera's corner radius (px).
 *  `mask`, when set, is the camera's outline in its box (unit polygon, see masks.ts) and wins over `radius`. */
export type LayoutState = { screen: Box; camera: Box | null; radius: number; mask?: number[] };

type Size = { width: number; height: number };

/** How long a layout switch takes by default, from the scene boundary (`transitions` may say otherwise). */
export const LAYOUT_SWITCH_US = DEFAULT_TRANSITION.durationUs;
/** Rounded mask: corner radius as a share of the short side. */
const ROUNDED_FRAC = 0.18;
/** Circle, square, star and custom masks: side as a share of the bubble width. */
const SQUARE_FRAC = 0.75;
/** Floating 9:16 panel: height as a share of the frame height. */
const FLOAT_FRAC = 0.8;
/** Morph at end: share of the switch spent travelling before the size and shape blend. */
const TRAVEL_FRAC = 0.7;
const STAR = starPolygon();

const isRight = (pip: Pip) => pip.corner === "topRight" || pip.corner === "bottomRight";
const isBottom = (pip: Pip) => pip.corner === "bottomLeft" || pip.corner === "bottomRight";

/** A box moved to the pip's free position (`x`, `y` shares of the frame), kept inside the frame. */
function placed(box: Box, out: Size, pip: Pip): Box {
  if (pip.x === undefined || pip.y === undefined) return box;
  const x = Math.min(Math.max(0, Math.round(pip.x * out.width)), Math.max(0, out.width - box.w));
  const y = Math.min(Math.max(0, Math.round(pip.y * out.height)), Math.max(0, out.height - box.h));
  return { ...box, x, y };
}

/** Whether a pip shape draws a square box (centre cropped): circle, square, star and the imported outline. */
export const isSquareShape = (shape: string) => shape === "circle" || shape === "square" || shape === "star" || shape === "custom";

/** The corner bubble's box, radius and outline for the pip's shape: in its corner, or at its free position.
 *  `custom` is the imported outline. */
export function bubbleBox(out: Size, cam: Size, pip: Pip, custom?: number[] | null): { box: Box; radius: number; mask?: number[] } {
  const s = pip.shape;
  if (isSquareShape(s)) {
    const side = Math.round(out.width * pip.widthFrac * SQUARE_FRAC);
    const m = Math.round(out.width * pip.marginFrac);
    const box = placed({ x: isRight(pip) ? out.width - m - side : m, y: isBottom(pip) ? out.height - m - side : m, w: side, h: side }, out, pip);
    if (s === "star") return { box, radius: 0, mask: STAR };
    if (s === "custom" && custom) return { box, radius: 0, mask: custom };
    return { box, radius: s === "square" ? 0 : side / 2 };
  }
  const box = placed(pipRect(out, cam, pip), out, pip);
  return { box, radius: s === "rounded" ? Math.round(Math.min(box.w, box.h) * ROUNDED_FRAC) : 0 };
}

/** Circle and square masks: side as a share of the bubble width. */
export const BUBBLE_SQUARE_FRAC = SQUARE_FRAC;

/** Side column panel: full height, 9:16 wide, on the corner's side. */
const sideWidth = (out: Size) => Math.round((out.height * 9) / 16);

/** A layout at rest. `custom` is the imported mask outline (`customMask`), if any. */
export function staticLayout(kind: LayoutKind, out: Size, cam: Size, pip: Pip, custom?: number[] | null): LayoutState {
  const full = { x: 0, y: 0, w: out.width, h: out.height };
  switch (kind) {
    case "pip": {
      const b = bubbleBox(out, cam, pip, custom);
      return b.mask ? { screen: full, camera: b.box, radius: 0, mask: b.mask } : { screen: full, camera: b.box, radius: b.radius };
    }
    case "float": {
      const h = Math.round(out.height * FLOAT_FRAC);
      const w = Math.round((h * 9) / 16);
      const m = Math.round(out.width * pip.marginFrac);
      const box = { x: isRight(pip) ? out.width - m - w : m, y: Math.round((out.height - h) / 2), w, h };
      return { screen: full, camera: box, radius: pip.shape === "rect" ? 0 : Math.round(Math.min(w, h) * ROUNDED_FRAC) };
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

/** Where a layout's camera comes from when it appears (and goes when it leaves): the side column and
 *  the floating panel slide from their edge, the others grow from the centre of their box. */
function hiddenCamera(kind: LayoutKind, at: Box, out: Size, pip: Pip): Box {
  if (kind === "side" || kind === "float") return { ...at, x: isRight(pip) ? out.width : -at.w };
  return { x: at.x + at.w / 2, y: at.y + at.h / 2, w: 0, h: 0 };
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const lerpBox = (a: Box, b: Box, p: number): Box => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) });
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const EASE: Record<TransitionEasing, (t: number) => number> = {
  linear: (t) => t,
  easeInOutCubic,
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
};
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** The layout in force at `t` (no switch): the later-starting scene that covers it, else the bubble. */
function kindAt(scenes: Scene[], t: number): LayoutKind {
  let k: LayoutKind = "pip";
  for (const s of scenes) {
    if (s.startUs > t) break;
    if (t < s.endUs) k = s.layout;
  }
  return k;
}

/** The switch in progress at `srcUs`, if any: its start, the two layouts and its preset. Used by the
 *  path editor on the preview. */
export function switchAt(project: Project, srcUs: number): { startUs: number; from: LayoutKind; to: LayoutKind; spec: SwitchSpec } | null {
  const scenes = cameraScenes(project);
  const bounds = [...new Set(scenes.flatMap((s) => [s.startUs, s.endUs]))].filter((b) => b > 0 && b <= srcUs).sort((a, b) => b - a);
  for (const c of bounds) {
    const from = kindAt(scenes, c - 1);
    const to = kindAt(scenes, c);
    if (from === to) continue;
    const spec = transitionFor(project, from, to);
    return srcUs - c < spec.durationUs ? { startUs: c, from, to, spec } : null;
  }
  return null;
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
  const custom = pip.shape === "custom" ? (customMask(project)?.points ?? null) : null;
  const bounds = [...new Set(scenes.flatMap((s) => [s.startUs, s.endUs]))].filter((b) => b > 0).sort((a, b) => b - a);
  const longest = Math.max(DEFAULT_TRANSITION.durationUs, ...cameraTransitions(project).map((x) => x.durationUs));

  // `before`: only boundaries strictly before it count (the state just before a switch at `before`).
  const state = (t: number, kind: LayoutKind, before: number, depth: number): LayoutState => {
    const to = statics ? statics(kind) : staticLayout(kind, out, cam, pip, custom);
    if (depth > 8) return to;
    for (const c of bounds) {
      if (c > t || c >= before) continue;
      if (c <= t - longest) break;
      const prev = kindAt(scenes, c - 1);
      if (prev === kindAt(scenes, c)) continue;
      const sw = transitionFor(project, prev, kind);
      if (t - c >= sw.durationUs) return to;
      const from = state(c, prev, c, depth + 1);
      return mix(from, prev, to, kind, (t - c) / sw.durationUs, sw, out, pip, !statics);
    }
    return to;
  };
  return state(srcUs, kindAt(scenes, srcUs), Infinity, 0);
}

/** The camera boxes a switch runs between (`from` at rest to `to` at rest), for drawing its path. */
export function switchEnds(project: Project, from: LayoutKind, to: LayoutKind, out: Size): { a: Box; b: Box } | null {
  const cam = project.tracks.camera;
  if (!cam) return null;
  const pip = cameraEdits(project).pip;
  const custom = customMask(project)?.points ?? null;
  const f = staticLayout(from, out, cam, pip, custom).camera;
  const t = staticLayout(to, out, cam, pip, custom).camera;
  if (!f && !t) return null;
  return { a: f ?? hiddenCamera(to, t!, out, pip), b: t ?? hiddenCamera(from, f!, out, pip) };
}

/** `from` (leaving layout `fromKind`) at p = 0 to `to` (layout `toKind`) at p = 1, with the switch's
 *  easing, path and morph. `p` is the share of the switch's length gone by. */
function mix(
  from: LayoutState,
  fromKind: LayoutKind,
  to: LayoutState,
  toKind: LayoutKind,
  p: number,
  sw: SwitchSpec,
  out: Size,
  pip: Pip,
  slide = true,
): LayoutState {
  if (p >= 1) return to;
  const ease = EASE[sw.easing] ?? easeInOutCubic;
  const e = ease(clamp01(p));
  const atEnd = sw.morph === "end";
  const pMove = atEnd ? ease(clamp01(p / TRAVEL_FRAC)) : e;
  const pSize = atEnd ? ease(clamp01((p - TRAVEL_FRAC) / (1 - TRAVEL_FRAC))) : e;
  const screen = lerpBox(from.screen, to.screen, e);
  if (!from.camera && !to.camera) return { screen, camera: null, radius: 0 };
  // A camera that appears comes from its hidden box (its edge or its centre), one that leaves goes to it.
  const a = from.camera ?? hiddenCamera(slide ? toKind : "pip", to.camera!, out, pip);
  const b = to.camera ?? hiddenCamera(slide ? fromKind : "pip", from.camera!, out, pip);
  const sliding = slide && ((!from.camera && slides(toKind)) || (!to.camera && slides(fromKind)));
  const camera = moveBox(a, b, pMove, sliding ? pMove : pSize, sw.path);
  if (from.camera && to.camera) {
    if (!from.mask && !to.mask) return { screen, camera, radius: lerp(from.radius, to.radius, pSize) };
    return { screen, camera, radius: 0, mask: lerpPolygon(outline(from), outline(to), pSize) };
  }
  if (to.camera) {
    const radius = sliding ? to.radius : to.radius * pSize;
    return to.mask ? { screen, camera, radius, mask: to.mask } : { screen, camera, radius };
  }
  const radius = sliding ? from.radius : from.radius * (1 - pSize);
  return from.mask ? { screen, camera, radius, mask: from.mask } : { screen, camera, radius };
}

const slides = (k: LayoutKind) => k === "side" || k === "float";

/** A state's camera outline, resampled for a morph. */
const outline = (s: LayoutState): number[] =>
  resamplePolygon(s.mask ?? roundRectPolygon(s.camera!.w, s.camera!.h, s.radius), MORPH_POINTS);

/** The camera box between `a` and `b`: its centre along the path (straight without one) at `pMove`, its
 *  size at `pSize`. The path's control points are relative to the a-to-b centre segment (`u` along it,
 *  `v` across it, a quarter turn clockwise on screen). */
function moveBox(a: Box, b: Box, pMove: number, pSize: number, path?: SwitchSpec["path"]): Box {
  if (!path && pMove === pSize) return lerpBox(a, b, pMove);
  const c = pathPoint(a, b, pMove, path);
  const w = lerp(a.w, b.w, pSize), h = lerp(a.h, b.h, pSize);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** The point at `t` (0..1) on a switch's path between the centres of `a` and `b`. */
export function pathPoint(a: Box, b: Box, t: number, path?: SwitchSpec["path"]): { x: number; y: number } {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  if (!path || Math.hypot(dx, dy) < 1) return { x: lerp(ax, bx, t), y: lerp(ay, by, t) };
  const [p1, p2] = pathControls(a, b, path);
  const u = 1 - t;
  return {
    x: u * u * u * ax + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * bx,
    y: u * u * u * ay + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * by,
  };
}

/** The path's two control points in frame pixels. */
export function pathControls(a: Box, b: Box, path: NonNullable<SwitchSpec["path"]>): [{ x: number; y: number }, { x: number; y: number }] {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const dx = b.x + b.w / 2 - ax, dy = b.y + b.h / 2 - ay;
  const ctl = ([u, v]: [number, number]) => ({ x: ax + u * dx - v * dy, y: ay + u * dy + v * dx });
  return [ctl(path.c1), ctl(path.c2)];
}

/** A frame point as path coordinates (`u` along the a-to-b centre segment, `v` across it). Null when
 *  the centres are within 1 px (no path possible). */
export function toPathCoords(a: Box, b: Box, pt: { x: number; y: number }): [number, number] | null {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const dx = b.x + b.w / 2 - ax, dy = b.y + b.h / 2 - ay;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1) return null;
  const px = pt.x - ax, py = pt.y - ay;
  return [(px * dx + py * dy) / L2, (-px * dy + py * dx) / L2];
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
): { source: S; srcSize: Size; rect: Box; radius: number; mirror: boolean; border: { width: number; color: string }; mask?: number[] } | null {
  if (!state.camera) return null;
  const b = cameraBorder(project);
  const width = b.width <= 0 ? 0 : Math.max(1, Math.round((b.width * out.height) / 1080));
  const layer = { source, srcSize, rect: state.camera, radius: state.radius, mirror: cameraEdits(project).mirror, border: { width, color: colors[b.color] } };
  return state.mask ? { ...layer, mask: state.mask } : layer;
}

/** The layout in force at `srcUs` when no switch is running (the bubble between scenes). */
export const layoutKindAt = (project: Project, srcUs: number): LayoutKind => kindAt(cameraScenes(project), srcUs);
