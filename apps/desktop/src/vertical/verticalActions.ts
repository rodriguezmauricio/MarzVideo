import { verticalEdits } from "@marz/format";
import { addHold, updateHold } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { aimNow } from "./aimPath";

const newId = () => `frame-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
/** A new Frame block is this long. */
export const HOLD_LEN_US = 2_000_000;

/** F: a 2 s Frame block at the playhead (in the free time after it), aimed where the window is now
 *  or at `x`. Selects it. Returns its id, or null when there is no room. */
export function holdFrameHere(x?: number): string | null {
  const { project, events, playheadUs, apply, select, verticalPreview, toggleVerticalPreview } = useEditorStore.getState();
  if (!project) return null;
  if (!verticalPreview) toggleVerticalPreview();
  const id = newId();
  apply(addHold({ id, startUs: playheadUs, endUs: playheadUs + HOLD_LEN_US, x: x ?? aimNow(project, events, playheadUs) }));
  const added = verticalEdits(useEditorStore.getState().project!).holds.some((h) => h.id === id);
  if (!added) return null;
  select({ kind: "frame", id });
  return id;
}

/** Aim the selected Frame block (or a new one at the playhead) at `x`: one undo step. */
export function aimFrameAt(x: number): void {
  const { selection, apply } = useEditorStore.getState();
  if (selection?.kind === "frame") apply(updateHold(selection.id, { x }));
  else holdFrameHere(x);
}
