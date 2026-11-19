import {
  aiEdits,
  captionEdits,
  cameraBorder,
  cameraEdits,
  type AiEdits,
  type CameraBorder,
  type AiKinds,
  type CameraEdits,
  type Cut,
  type Pip,
  type Project,
  type RejectedAiEdit,
  type Zoom,
} from "@marz/format";

export type Command = (p: Project) => Project;
export type Range = { startUs: number; endUs: number };

const withEdits = (p: Project, patch: Partial<Project["edits"]>): Project => ({
  ...p,
  edits: { ...p.edits, ...patch },
});

/** Return `p` itself (no new object) when there is nothing to change, so History can skip the entry. */
const mapById = <T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T[] | null => {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const cur = list[i] as Record<string, unknown>;
  if (Object.entries(patch).every(([k, v]) => JSON.stringify(cur[k]) === JSON.stringify(v))) return null; // nothing changes
  return list.map((x, j) => (j === i ? { ...x, ...patch } : x));
};

const overlaps = (a: Range, b: Range) => a.startUs < b.endUs && b.startUs < a.endUs;
const sameRect = (a: Zoom["rect"], b: Zoom["rect"]) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** A zoom or cut the AI pass made (or an M1 suggested zoom) becomes the user's own when its time or
 * rect changes, so a rerun never touches it again. */
const ownsZoom = (z: Zoom, patch: Partial<Zoom>): Partial<Zoom> => {
  if (z.origin !== "ai" && z.origin !== "auto") return patch;
  const moved =
    (patch.startUs !== undefined && patch.startUs !== z.startUs) ||
    (patch.endUs !== undefined && patch.endUs !== z.endUs) ||
    (patch.rect !== undefined && !sameRect(patch.rect, z.rect));
  return moved && patch.origin === undefined ? { ...patch, origin: "manual" } : patch;
};

const ownsCut = (c: Cut, patch: Partial<Cut>): Partial<Cut> => {
  if (c.origin !== "ai") return patch;
  const moved = (patch.startUs !== undefined && patch.startUs !== c.startUs) || (patch.endUs !== undefined && patch.endUs !== c.endUs);
  return moved && patch.origin === undefined ? { ...patch, origin: "manual" } : patch;
};

const withAi = (p: Project, patch: Partial<AiEdits>): Project => withEdits(p, { ai: { ...aiEdits(p), ...patch } });

/** What a deleted AI edit covered, so a rerun or the pace slider never brings it back. */
function rejectionFor(e: Cut | Zoom, kind: "cut" | "zoom"): RejectedAiEdit | null {
  const r = e as Record<string, unknown>;
  if (kind === "zoom") return typeof r.candidateId === "string" ? { kind: "zoom", candidateId: r.candidateId } : null;
  const { reason, fromWordId, toWordId } = r;
  if ((reason === "silence" || reason === "filler" || reason === "mistake") && typeof fromWordId === "string" && typeof toWordId === "string")
    return { kind: "cut", reason, fromWordId, toWordId };
  return null;
}

export const addZoom =
  (z: Zoom): Command =>
  (p) =>
    withEdits(p, { zooms: [...p.edits.zooms, z] });

export const updateZoom =
  (id: string, patch: Partial<Zoom>): Command =>
  (p) => {
    const z = p.edits.zooms.find((x) => x.id === id);
    if (!z) return p;
    const zooms = mapById(p.edits.zooms, id, ownsZoom(z, patch));
    return zooms ? withEdits(p, { zooms }) : p;
  };

export const removeZoom =
  (id: string): Command =>
  (p) => {
    const z = p.edits.zooms.find((x) => x.id === id);
    if (!z) return p;
    const next = withEdits(p, { zooms: p.edits.zooms.filter((x) => x.id !== id) });
    const rej = z.origin === "ai" ? rejectionFor(z, "zoom") : null;
    return rej ? withAi(next, { rejected: [...aiEdits(p).rejected, rej] }) : next;
  };

export const addCut =
  (c: Cut): Command =>
  (p) =>
    withEdits(p, { cuts: [...p.edits.cuts, c] });

export const updateCut =
  (id: string, patch: Partial<Cut>): Command =>
  (p) => {
    const c = p.edits.cuts.find((x) => x.id === id);
    if (!c) return p;
    const cuts = mapById(p.edits.cuts, id, ownsCut(c, patch));
    return cuts ? withEdits(p, { cuts }) : p;
  };

export const removeCut =
  (id: string): Command =>
  (p) => {
    const c = p.edits.cuts.find((x) => x.id === id);
    if (!c) return p;
    const next = withEdits(p, { cuts: p.edits.cuts.filter((x) => x.id !== id) });
    const rej = c.origin === "ai" ? rejectionFor(c, "cut") : null;
    return rej ? withAi(next, { rejected: [...aiEdits(p).rejected, rej] }) : next;
  };

/** Pressing A: the click rules again. Replaces only suggested ("auto") zooms and skips clusters that
 * overlap an AI, manual or live zoom. */
export const replaceAutoZooms =
  (zs: Zoom[]): Command =>
  (p) => {
    const kept = p.edits.zooms.filter((z) => z.origin !== "auto");
    return withEdits(p, { zooms: [...kept, ...zs.filter((z) => !kept.some((k) => overlaps(k, z)))] });
  };

export const setCursorHidden =
  (hidden: boolean): Command =>
  (p) =>
    withEdits(p, { cursor: { ...p.edits.cursor, hidden } });

/** Change the camera picture-in-picture (show, mirror, corner, size, shape) and its border. Writes
 *  the whole `edits.camera` (defaults filled in), keeping fields this build does not know and the
 *  scenes. Returns `p` itself when nothing changes, so History skips the entry. */
export const updateCamera =
  (patch: Partial<Omit<CameraEdits, "pip" | "border">> & { pip?: Partial<Pip>; border?: Partial<CameraBorder> }): Command =>
  (p) => {
    const cur = cameraEdits(p);
    const { border: borderPatch, pip: pipPatch, ...rest } = patch;
    const border = borderPatch ? { ...cameraBorder(p), ...borderPatch } : cur.border;
    const next: CameraEdits = { ...cur, ...rest, pip: { ...cur.pip, ...pipPatch }, ...(border ? { border } : {}) };
    const same =
      next.visible === cur.visible &&
      next.mirror === cur.mirror &&
      next.pip.corner === cur.pip.corner &&
      next.pip.widthFrac === cur.pip.widthFrac &&
      next.pip.marginFrac === cur.pip.marginFrac &&
      next.pip.shape === cur.pip.shape &&
      JSON.stringify(next.border ?? null) === JSON.stringify(cur.border ?? null);
    return same ? p : withEdits(p, { camera: next });
  };

// ---- AI pass ------------------------------------------------------------------------------------

/** New AI cuts that do not land on the user's own cuts or on ranges he touched during the run. */
const keepCuts = (cuts: Cut[], own: Cut[], touched: Range[]) =>
  cuts.filter((c) => !touched.some((t) => overlaps(c, t)) && !own.some((o) => overlaps(c, o)));

const keepZooms = (zooms: Zoom[], own: Zoom[], touched: Range[]) =>
  zooms.filter((z) => !touched.some((t) => overlaps(z, t)) && !own.some((o) => overlaps(z, o)));

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One AI pass as one undo step: removes the previous AI cuts and zooms and the untouched suggested
 * zooms, adds the new ones except where they would land on the user's own edits or on what he
 * changed during the run, and records the run. Returns `p` itself when nothing would change. */
export const applyAiPass =
  (
    next: { cuts: Cut[]; zooms: Zoom[] },
    guard: { touchedSince: Range[] },
    meta: NonNullable<AiEdits["lastRun"]> & { result: unknown },
  ): Command =>
  (p) => {
    const ownCuts = p.edits.cuts.filter((c) => c.origin !== "ai");
    const ownZooms = p.edits.zooms.filter((z) => z.origin !== "ai" && z.origin !== "auto");
    const cuts = [...ownCuts, ...keepCuts(next.cuts, ownCuts, guard.touchedSince)];
    const zooms = [...ownZooms, ...keepZooms(next.zooms, ownZooms, guard.touchedSince)];
    const { result, ...lastRun } = meta;
    const ai = aiEdits(p);
    const unchanged =
      sameJson(cuts, p.edits.cuts) &&
      sameJson(zooms, p.edits.zooms) &&
      sameJson(result ?? null, ai.lastResult ?? null) &&
      sameJson(lastRun.languages, ai.lastRun?.languages) &&
      lastRun.model === ai.lastRun?.model;
    if (unchanged) return p;
    return withEdits(p, { cuts, zooms, ai: { ...ai, lastRun, lastResult: result ?? undefined } });
  };

/** The pace slider: new padding for the AI cuts (rebuilt by the caller without calling the AI). */
export const setAiPace =
  (paceUs: number, rebuilt: { cuts: Cut[] }): Command =>
  (p) => {
    const ai = aiEdits(p);
    const ownCuts = p.edits.cuts.filter((c) => c.origin !== "ai");
    const cuts = [...ownCuts, ...keepCuts(rebuilt.cuts, ownCuts, [])];
    if (paceUs === ai.paceUs && sameJson(cuts, p.edits.cuts)) return p;
    return withEdits(p, { cuts, ai: { ...ai, paceUs } });
  };

/** The kind toggles: which AI edits are on, rebuilt by the caller from the kept result. */
export const setAiKinds =
  (kinds: AiKinds, rebuilt: { cuts: Cut[]; zooms: Zoom[] }): Command =>
  (p) => {
    const ai = aiEdits(p);
    const ownCuts = p.edits.cuts.filter((c) => c.origin !== "ai");
    const ownZooms = p.edits.zooms.filter((z) => z.origin !== "ai");
    const cuts = [...ownCuts, ...keepCuts(rebuilt.cuts, ownCuts, [])];
    const zooms = [...ownZooms, ...keepZooms(rebuilt.zooms, ownZooms, [])];
    if (sameJson(kinds, ai.kinds) && sameJson(cuts, p.edits.cuts) && sameJson(zooms, p.edits.zooms)) return p;
    return withEdits(p, { cuts, zooms, ai: { ...ai, kinds } });
  };

/** Time ranges of cuts and zooms added, changed or removed between two versions of a project.
 * Caption and setting changes are not counted. */
export function touchedRanges(before: Project, after: Project): Range[] {
  const out: Range[] = [];
  const diff = <T extends { id: string; startUs: number; endUs: number }>(a: T[], b: T[]) => {
    const A = new Map(a.map((x) => [x.id, x]));
    const B = new Map(b.map((x) => [x.id, x]));
    for (const [id, x] of A) {
      const y = B.get(id);
      if (!y) out.push({ startUs: x.startUs, endUs: x.endUs });
      else if (!sameJson(x, y)) out.push({ startUs: x.startUs, endUs: x.endUs }, { startUs: y.startUs, endUs: y.endUs });
    }
    for (const [id, y] of B) if (!A.has(id)) out.push({ startUs: y.startUs, endUs: y.endUs });
  };
  diff(before.edits.cuts, after.edits.cuts);
  diff(before.edits.zooms, after.edits.zooms);
  return out;
}

// ---- Captions -----------------------------------------------------------------------------------

/** Fix a caption word's text (null removes the fix). One undo step; `transcript.json` is untouched. */
export const setCaptionText =
  (wordId: string, text: string | null): Command =>
  (p) => {
    const cur = captionEdits(p);
    const has = Object.prototype.hasOwnProperty.call(cur.overrides, wordId);
    if (text === null ? !has : cur.overrides[wordId] === text) return p;
    const overrides = { ...cur.overrides };
    if (text === null) delete overrides[wordId];
    else overrides[wordId] = text;
    return withEdits(p, { captions: { ...cur, overrides } });
  };

/** Hide a word from captions without cutting its audio, or show it again. */
export const setCaptionHidden =
  (wordId: string, hidden: boolean): Command =>
  (p) => {
    const cur = captionEdits(p);
    const is = cur.hidden.includes(wordId);
    if (is === hidden) return p;
    return withEdits(p, { captions: { ...cur, hidden: hidden ? [...cur.hidden, wordId] : cur.hidden.filter((x) => x !== wordId) } });
  };
