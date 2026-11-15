import type { Cut, Project, Zoom } from "@marz/format";

export type Command = (p: Project) => Project;

const withEdits = (p: Project, patch: Partial<Project["edits"]>): Project => ({
  ...p,
  edits: { ...p.edits, ...patch },
});

/** Return `p` itself (no new object) when there is nothing to change, so History can skip the entry. */
const mapById = <T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T[] | null => {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  return list.map((x, j) => (j === i ? { ...x, ...patch } : x));
};

export const addZoom =
  (z: Zoom): Command =>
  (p) =>
    withEdits(p, { zooms: [...p.edits.zooms, z] });

export const updateZoom =
  (id: string, patch: Partial<Zoom>): Command =>
  (p) => {
    const zooms = mapById(p.edits.zooms, id, patch);
    return zooms ? withEdits(p, { zooms }) : p;
  };

export const removeZoom =
  (id: string): Command =>
  (p) =>
    p.edits.zooms.some((z) => z.id === id) ? withEdits(p, { zooms: p.edits.zooms.filter((z) => z.id !== id) }) : p;

export const addCut =
  (c: Cut): Command =>
  (p) =>
    withEdits(p, { cuts: [...p.edits.cuts, c] });

export const updateCut =
  (id: string, patch: Partial<Cut>): Command =>
  (p) => {
    const cuts = mapById(p.edits.cuts, id, patch);
    return cuts ? withEdits(p, { cuts }) : p;
  };

export const removeCut =
  (id: string): Command =>
  (p) =>
    p.edits.cuts.some((c) => c.id === id) ? withEdits(p, { cuts: p.edits.cuts.filter((c) => c.id !== id) }) : p;

export const replaceAutoZooms =
  (zs: Zoom[]): Command =>
  (p) =>
    withEdits(p, { zooms: [...p.edits.zooms.filter((z) => z.origin !== "auto"), ...zs] });

export const setCursorHidden =
  (hidden: boolean): Command =>
  (p) =>
    withEdits(p, { cursor: { ...p.edits.cursor, hidden } });
