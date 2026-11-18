import { cameraEdits, type Pip, type Project } from "@marz/format";

export type Box = { x: number; y: number; w: number; h: number };

/** Where the camera goes on a frame of size `out`: in `pip.corner`, `pip.widthFrac` of the frame's
 *  width wide, the camera's aspect kept (never cropped), `pip.marginFrac` of the width from the
 *  edges. Whole pixels, so preview and export put it on the same pixels. */
export function pipRect(out: { width: number; height: number }, cam: { width: number; height: number }, pip: Pip): Box {
  const w = Math.round(out.width * pip.widthFrac);
  const h = Math.round((w * cam.height) / Math.max(1, cam.width));
  const m = Math.round(out.width * pip.marginFrac);
  const right = pip.corner === "topRight" || pip.corner === "bottomRight";
  const bottom = pip.corner === "bottomLeft" || pip.corner === "bottomRight";
  return { x: right ? out.width - m - w : m, y: bottom ? out.height - m - h : m, w, h };
}

/** The camera picture-in-picture for `project` on a frame of size `out`, or null when the project
 *  has no camera or it is hidden. */
export function cameraLayout(project: Project, out: { width: number; height: number }): { rect: Box; mirror: boolean } | null {
  const cam = project.tracks.camera;
  if (!cam) return null;
  const edits = cameraEdits(project);
  if (!edits.visible) return null;
  return { rect: pipRect(out, cam, edits.pip), mirror: edits.mirror };
}

/** Media time in camera.mp4 for source time `srcUs`: its first frame was taken at `offsetUs` and is
 *  presented at 0 (no B-frames). Before it the first frame shows, after its end the last one. */
export function cameraMediaUs(project: Project, srcUs: number): number {
  return Math.max(0, srcUs - (project.tracks.camera?.offsetUs ?? 0));
}
