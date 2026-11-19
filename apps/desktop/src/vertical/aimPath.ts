import type { MarzEvent, Project } from "@marz/format";
import { aimAt, autoAim, cropRectAt, zoomRectAt, type AimPath } from "@marz/timeline";
import { verticalEdits } from "@marz/format";

/** The automatic aim for a project and its event log, computed once per change of what it reads
 *  (events, zooms, size, length). Preview and export share it. */
let memo: { events: MarzEvent[]; zooms: Project["edits"]["zooms"]; w: number; h: number; d: number; path: AimPath } | null = null;

export function aimPathFor(project: Project, events: MarzEvent[]): AimPath {
  const z = project.edits.zooms;
  const { width: w, height: h } = project.source;
  const d = project.durationUs;
  if (memo && memo.events === events && memo.zooms === z && memo.w === w && memo.h === h && memo.d === d) return memo.path;
  const path = autoAim(events, project.source, d, z);
  memo = { events, zooms: z, w, h, d, path };
  return path;
}

/** The window's centre (share of the screen width) at `srcUs`, his Frame blocks included, kept
 *  inside the screen (and the zoom area) for a full-height 9:16 window. */
export function aimNow(project: Project, events: MarzEvent[], srcUs: number): number {
  const x = aimAt(aimPathFor(project, events), verticalEdits(project).holds, srcUs);
  const r = cropRectAt(x, zoomRectAt(project.edits.zooms, srcUs), project.source, 9 / 16);
  return r.x + r.w / 2;
}
