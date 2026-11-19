import { cameraEdits, cameraTransitions, transitionFor, type CameraEdits, type CustomMask, type LayoutKind, type Project, type SwitchSpec } from "@marz/format";
import type { Command } from "./commands";

const withCamera = (p: Project, camera: CameraEdits): Project => ({ ...p, edits: { ...p.edits, camera } });

/** Change the switch preset from layout `from` to `to` (camera extras design). Starts from the preset in
 *  force (or the default); `path: null` makes it straight. Keeps one entry per pair and the entries this
 *  build cannot read. Returns `p` itself when nothing changes, so History skips the entry. */
export const setTransition =
  (from: LayoutKind, to: LayoutKind, patch: Partial<Omit<SwitchSpec, "path">> & { path?: SwitchSpec["path"] | null }): Command =>
  (p) => {
    const cur = transitionFor(p, from, to);
    const { path, ...rest } = patch;
    const next: SwitchSpec = { ...cur, ...rest };
    if (path === null) delete next.path;
    else if (path) next.path = path;
    if (JSON.stringify(next) === JSON.stringify(cur)) return p;
    const edits = cameraEdits(p);
    const known = new Set(cameraTransitions(p));
    const others = ((edits.transitions ?? []) as unknown[]).filter((t) => {
      const k = t as { from?: string; to?: string };
      return !(known.has(t as never) && k.from === from && k.to === to);
    });
    return withCamera(p, { ...edits, transitions: [...others, { from, to, ...next }] });
  };

/** Store an imported mask outline and switch the camera to the custom shape. */
export const setCustomMask =
  (mask: CustomMask): Command =>
  (p) => {
    const edits = cameraEdits(p);
    const cur = edits.customMask as CustomMask | undefined;
    const same = edits.pip.shape === "custom" && cur?.name === mask.name && JSON.stringify(cur?.points) === JSON.stringify(mask.points);
    if (same) return p;
    return withCamera(p, { ...edits, pip: { ...edits.pip, shape: "custom" }, customMask: { name: mask.name, points: [...mask.points] } });
  };
