import { cameraScenes, type Cut, type Zoom } from "@marz/format";
import {
  addCut,
  addScene,
  addZoom,
  lockAspect,
  removeCut,
  removeHold,
  removeScene,
  removeZoom,
  replaceAutoZooms,
  suggestZooms,
} from "@marz/timeline";
import { useEditorStore } from "./editorStore";

const MIN_US = 100_000;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** Start/end for a new block of `lenUs` at the playhead, kept inside the video. */
function rangeAtPlayhead(lenUs: number, durationUs: number, playheadUs: number): { startUs: number; endUs: number } {
  const len = Math.min(lenUs, durationUs);
  const startUs = Math.max(0, Math.min(playheadUs, durationUs - len));
  return { startUs, endUs: startUs + len };
}

export function addZoomAtPlayhead(): void {
  const { project, playheadUs, apply, select } = useEditorStore.getState();
  if (!project) return;
  const aspect = project.output.width / project.output.height;
  const z: Zoom = {
    id: newId("zoom"),
    ...rangeAtPlayhead(3_000_000, project.durationUs, playheadUs),
    rect: lockAspect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, aspect, project.source),
    easeInUs: 400_000,
    easeOutUs: 400_000,
    easing: "easeInOutCubic",
    origin: "manual",
  };
  apply(addZoom(z));
  select({ kind: "zoom", id: z.id });
}

export function addCutAtPlayhead(): void {
  const { project, playheadUs, apply, select } = useEditorStore.getState();
  if (!project) return;
  const c: Cut = { id: newId("cut"), ...rangeAtPlayhead(2_000_000, project.durationUs, playheadUs) };
  apply(addCut(c));
  select({ kind: "cut", id: c.id });
}

/** L: a 4 s Side layout at the playhead, in the free time after it (projects with a camera). */
export function addLayoutAtPlayhead(): void {
  const { project, playheadUs, apply, select } = useEditorStore.getState();
  if (!project?.tracks.camera) return;
  const id = newId("layout");
  apply(addScene({ id, startUs: playheadUs, endUs: playheadUs + 4_000_000, layout: "side", origin: "manual" }));
  if (cameraScenes(useEditorStore.getState().project!).some((s) => s.id === id)) select({ kind: "layout", id });
}

export function runAutoZoom(): void {
  const { project, events, apply } = useEditorStore.getState();
  if (!project) return;
  const aspect = project.output.width / project.output.height;
  apply(replaceAutoZooms(suggestZooms(events, project.source, aspect)));
}

export function deleteSelection(): void {
  const { selection, apply, select } = useEditorStore.getState();
  // A caption word is not deleted (hide it from captions in the inspector instead).
  if (!selection || selection.kind === "word") return;
  apply(
    selection.kind === "frame"
      ? removeHold(selection.id)
      : selection.kind === "layout"
        ? removeScene(selection.id)
        : selection.kind === "zoom"
          ? removeZoom(selection.id)
          : removeCut(selection.id),
  );
  select(null);
}

export { MIN_US };
