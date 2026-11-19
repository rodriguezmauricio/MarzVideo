import { cameraEdits, verticalEdits, type CameraSlot, type LayoutKind, type MarzEvent, type Project, type Zoom } from "@marz/format";
import { aimAt, cropRectAt, zoomRectAt, type AimPath } from "@marz/timeline";
import { framedBox } from "./background";
import type { Box } from "./camera";
import type { CaptionRect } from "./captions";
import { frameAt, type FrameSpec } from "./frame";
import { layoutAt, type LayoutState } from "./layout";

/** Smart vertical (docs/superpowers/specs/2026-11-19-smart-vertical-design.md): the 9:16 picture. */
export const VERTICAL_SIZE = { width: 1080, height: 1920 } as const;
/** The camera slot's height: 1080 x 608 is 16:9, so a 16:9 camera fills it uncropped. */
export const CAMERA_SLOT_H = 608;
/** Reels and TikTok safe area: shares of the width (each side) and of the height (top, bottom). */
export const SAFE_AREA = { side: 0.06, top: 0.13, bottom: 0.2 } as const;
/** Captions keep this share of the height away from the screen box edges (the camera seam). */
const SEAM_GAP = 0.02;
/** Below this height the screen box no longer bounds the captions. */
const MIN_CAPTION_BOX = 300;

type Size = { width: number; height: number };

/** The vertical boxes of a layout at rest: the camera in its slot (corner bubble and side column),
 *  full frame (camera), or no camera (screen only). */
export function verticalBoxes(kind: LayoutKind, slot: CameraSlot, out: Size = VERTICAL_SIZE): LayoutState {
  const full = { x: 0, y: 0, w: out.width, h: out.height };
  const slotH = Math.round((CAMERA_SLOT_H * out.height) / VERTICAL_SIZE.height);
  switch (kind) {
    case "pip":
    case "side":
    case "float":
      return slot === "top"
        ? { screen: { x: 0, y: slotH, w: out.width, h: out.height - slotH }, camera: { x: 0, y: 0, w: out.width, h: slotH }, radius: 0 }
        : { screen: { x: 0, y: 0, w: out.width, h: out.height - slotH }, camera: { x: 0, y: out.height - slotH, w: out.width, h: slotH }, radius: 0 };
    case "camera":
      return { screen: full, camera: { ...full }, radius: 0 };
    default:
      return { screen: full, camera: null, radius: 0 };
  }
}

/** Screen and camera boxes on the vertical picture at `srcUs`: the same scenes and switches as 16:9. */
export function verticalLayoutAt(project: Project, srcUs: number, out: Size = VERTICAL_SIZE): LayoutState {
  const slot = verticalEdits(project).cameraSlot;
  return layoutAt(project, srcUs, out, (kind) => verticalBoxes(kind, slot, out));
}

/** Everything to draw the vertical frame at `srcUs`: the screen spec (the aimed window fitted into the
 *  screen box, the cursor from the event log), the layout (for the camera) and the window itself
 *  (normalized, for the Aim view). */
export function verticalFrameAt(
  project: Project,
  events: MarzEvent[],
  path: AimPath,
  srcUs: number,
  out: Size = VERTICAL_SIZE,
): { spec: FrameSpec; layout: LayoutState; crop: Box } {
  const layout = verticalLayoutAt(project, srcUs, out);
  const box = layout.screen;
  const zoom = zoomRectAt(project.edits.zooms, srcUs);
  const aim = aimAt(path, verticalEdits(project).holds, srcUs);
  // With a background the window is cut to the framed box (the screen box less the margin).
  const framed = framedBox(project, box, out);
  const crop = cropRectAt(aim, zoom, project.source, framed.w / Math.max(1, framed.h));
  // The window as a zoom that covers the whole take: frameAt then places the screen and the cursor.
  const window: Zoom = { id: "vertical-window", startUs: 0, endUs: Number.MAX_SAFE_INTEGER, rect: crop, easeInUs: 0, easeOutUs: 0, easing: "linear", origin: "manual" };
  const shown = { ...project, edits: { ...project.edits, zooms: [window] } };
  return { spec: frameAt(shown, events, srcUs, box, { out, fill: true }), layout, crop };
}

/** Where captions may go on the vertical picture: the safe area, kept inside the screen box (away
 *  from the camera seam) while the camera is shown in a slot. */
export function verticalCaptionArea(layout: LayoutState, out: Size = VERTICAL_SIZE): CaptionRect {
  const x = out.width * SAFE_AREA.side;
  let top = out.height * SAFE_AREA.top;
  let bottom = out.height * (1 - SAFE_AREA.bottom);
  const s = layout.screen;
  const gap = out.height * SEAM_GAP;
  if (layout.camera && s.h >= MIN_CAPTION_BOX && s.h < out.height - 1) {
    top = Math.max(top, s.y + gap);
    bottom = Math.min(bottom, s.y + s.h - gap);
  }
  return { x, y: top, w: out.width - 2 * x, h: Math.max(0, bottom - top) };
}

/** The camera is shown on the vertical picture at all (the layout decides where). */
export const verticalHasCamera = (p: Project): boolean => !!p.tracks.camera && cameraEdits(p).visible;
