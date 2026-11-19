import { rawVertical, verticalEdits, type CameraSlot, type Project, type VerticalFraming, type VerticalHold } from "@marz/format";
import type { Command } from "./commands";

/** Shortest Frame block. */
export const MIN_HOLD_US = 100_000;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Write `edits.vertical` with `patch` over what is there, keeping fields and holds this build cannot read. */
function withVertical(p: Project, patch: Record<string, unknown>, holds?: VerticalHold[]): Project {
  const raw = rawVertical(p);
  const next: Record<string, unknown> = { ...raw, ...patch };
  if (holds) {
    const known = new Set(verticalEdits(p).holds.map((h) => h.id));
    const unknown = (Array.isArray(raw.holds) ? (raw.holds as unknown[]) : []).filter((h) => !(h && typeof h === "object" && known.has((h as { id?: unknown }).id as string)));
    next.holds = [...[...holds].sort((a, b) => a.startUs - b.startUs), ...unknown];
  }
  return { ...p, edits: { ...p.edits, vertical: next } };
}

/** Framing and camera slot. Returns `p` when nothing changes. */
export const setVertical =
  (patch: Partial<{ framing: VerticalFraming; cameraSlot: CameraSlot }>): Command =>
  (p) => {
    const cur = verticalEdits(p);
    const raw = rawVertical(p);
    const same = Object.entries(patch).every(([k, v]) => raw[k] === v || (raw[k] === undefined && (cur as Record<string, unknown>)[k] === v && k !== "cameraSlot"));
    if (same) return p;
    return withVertical(p, patch);
  };

/** Add a Frame block in the free time after its start (as layout scenes): a start inside another
 *  block moves to its end, the end stops at the next block or the end of the video. No room: `p`. */
export const addHold =
  (h: VerticalHold): Command =>
  (p) => {
    const list = verticalEdits(p).holds;
    const D = p.durationUs;
    let start = Math.max(0, Math.min(h.startUs, D));
    for (const x of list) if (x.startUs <= start && start < x.endUs) start = x.endUs;
    const next = list.filter((x) => x.startUs >= start).reduce((m, x) => Math.min(m, x.startUs), D);
    const end = Math.min(h.endUs, D, next);
    if (end - start < MIN_HOLD_US) return p;
    return withVertical(p, {}, [...list, { ...h, x: clamp01(h.x), startUs: start, endUs: end }]);
  };

/** Change a Frame block's time or aim, kept between its neighbours and at least MIN_HOLD_US long.
 *  A move (both ends, same length) keeps its length. Returns `p` when nothing changes. */
export const updateHold =
  (id: string, patch: Partial<Pick<VerticalHold, "startUs" | "endUs" | "x">>): Command =>
  (p) => {
    const list = verticalEdits(p).holds;
    const cur = list.find((x) => x.id === id);
    if (!cur) return p;
    const others = list.filter((x) => x.id !== id);
    const prevEnd = others.filter((x) => x.startUs < cur.startUs).reduce((m, x) => Math.max(m, x.endUs), 0);
    const nextStart = others.filter((x) => x.startUs >= cur.startUs).reduce((m, x) => Math.min(m, x.startUs), p.durationUs);
    const len = cur.endUs - cur.startUs;
    const isMove = patch.startUs !== undefined && patch.endUs !== undefined && patch.endUs - patch.startUs === len;
    const startUs = isMove
      ? Math.max(prevEnd, Math.min(patch.startUs!, nextStart - len))
      : Math.max(prevEnd, Math.min(patch.startUs ?? cur.startUs, nextStart - MIN_HOLD_US));
    const endUs = isMove ? startUs + len : Math.min(nextStart, Math.max(patch.endUs ?? cur.endUs, startUs + MIN_HOLD_US));
    const x = patch.x === undefined ? cur.x : clamp01(patch.x);
    if (startUs === cur.startUs && endUs === cur.endUs && x === cur.x) return p;
    return withVertical(p, {}, [...others, { ...cur, startUs, endUs, x }]);
  };

export const removeHold =
  (id: string): Command =>
  (p) => {
    const list = verticalEdits(p).holds;
    if (!list.some((x) => x.id === id)) return p;
    return withVertical(p, {}, list.filter((x) => x.id !== id));
  };
