import {
  clickSettings,
  cursorKind,
  cursorLiveImported,
  cursorSections,
  cursorSize,
  rawCursorSections,
  type ClickSettings,
  type CursorSection,
  type CursorSize,
  type MarzEvent,
  type Project,
} from "@marz/format";
import type { Command } from "./commands";

/** Shortest cursor block. */
export const MIN_CURSOR_SECTION_US = 100_000;

const sameSection = (a: CursorSection, b: CursorSection) =>
  a.startUs === b.startUs && a.endUs === b.endUs && a.hide === b.hide && a.clicks === b.clicks;

/** Write the sections, keeping entries this build cannot read. */
function withSections(p: Project, list: CursorSection[]): Project {
  const known = new Set(cursorSections(p).map((s) => s.id));
  const unknown = rawCursorSections(p).filter((s) => !known.has((s as { id?: unknown } | null)?.id as string));
  const sections = [...list.sort((a, b) => a.startUs - b.startUs), ...unknown];
  return { ...p, edits: { ...p.edits, cursor: { ...p.edits.cursor, sections } } };
}

/** Add a cursor block in the free time after its start (same rule as layout scenes). No room: `p`. */
export const addCursorSection =
  (s: CursorSection): Command =>
  (p) => {
    const list = cursorSections(p);
    const D = p.durationUs;
    let start = Math.max(0, Math.min(s.startUs, D));
    for (const x of list) if (x.startUs <= start && start < x.endUs) start = x.endUs;
    const next = list.filter((x) => x.startUs >= start).reduce((m, x) => Math.min(m, x.startUs), D);
    const end = Math.min(s.endUs, D, next);
    if (end - start < MIN_CURSOR_SECTION_US) return p;
    return withSections(p, [...list, { ...s, startUs: start, endUs: end }]);
  };

/** Change a block's time or switches, kept between its neighbours and at least the minimum long. */
export const updateCursorSection =
  (id: string, patch: Partial<Omit<CursorSection, "id">>): Command =>
  (p) => {
    const list = cursorSections(p);
    const cur = list.find((x) => x.id === id);
    if (!cur) return p;
    const others = list.filter((x) => x.id !== id);
    const prevEnd = others.filter((x) => x.startUs < cur.startUs).reduce((m, x) => Math.max(m, x.endUs), 0);
    const nextStart = others.filter((x) => x.startUs >= cur.startUs).reduce((m, x) => Math.min(m, x.startUs), p.durationUs);
    const len = cur.endUs - cur.startUs;
    const isMove = patch.startUs !== undefined && patch.endUs !== undefined && patch.endUs - patch.startUs === len;
    const startUs = isMove
      ? Math.max(prevEnd, Math.min(patch.startUs!, nextStart - len))
      : Math.max(prevEnd, Math.min(patch.startUs ?? cur.startUs, nextStart - MIN_CURSOR_SECTION_US));
    const endUs = isMove ? startUs + len : Math.min(nextStart, Math.max(patch.endUs ?? cur.endUs, startUs + MIN_CURSOR_SECTION_US));
    const next: CursorSection = { ...cur, startUs, endUs, hide: patch.hide ?? cur.hide, clicks: patch.clicks ?? cur.clicks };
    if (sameSection(next, cur)) return p;
    return withSections(p, [...others, next]);
  };

export const removeCursorSection =
  (id: string): Command =>
  (p) => {
    const list = cursorSections(p);
    if (!list.some((x) => x.id === id)) return p;
    return withSections(p, list.filter((x) => x.id !== id));
  };

export const setCursorSize =
  (size: CursorSize): Command =>
  (p) =>
    cursorSize(p) === size && (p.edits.cursor as { size?: unknown }).size !== undefined
      ? p
      : { ...p, edits: { ...p.edits, cursor: { ...p.edits.cursor, size } } };

/** Turn click effects on or off for the whole video, or change their style, colour or size. */
export const setClicks =
  (patch: Partial<ClickSettings>): Command =>
  (p) => {
    const cur = clickSettings(p);
    const next = { ...cur, ...patch };
    if (next.on === cur.on && next.style === cur.style && next.color === cur.color && next.size === cur.size) return p;
    const clicks = { ...p.edits.clicks, effect: next.on ? next.style : "none", style: next.style, color: next.color, size: next.size };
    return { ...p, edits: { ...p.edits, clicks } };
  };

/** Turn the live hide cursor presses (`cursorHidden` lines) into Cursor lane blocks, once per project
 *  (`edits.cursor.liveImported`). The live state starts at the whole-video setting (the setup bar's
 *  Hide cursor toggle); every stretch where it differs becomes a block with that `hide`, the video's
 *  click effects copied in. A stretch still open at Stop runs to the end; repeats are ignored; a
 *  baked cursor gets no blocks. Returns `p` when there is nothing to mark. */
export const importLiveCursor =
  (events: MarzEvent[]): Command =>
  (p) => {
    if (cursorLiveImported(p)) return p;
    const D = p.durationUs;
    const lines = events
      .filter((e): e is Extract<MarzEvent, { type: "cursorHidden" }> => e.type === "cursorHidden" && e.tUs >= 0 && e.tUs < D)
      .sort((a, b) => a.tUs - b.tUs);
    if (lines.length === 0) return p;
    const base = p.edits.cursor.hidden;
    const clicks = clickSettings(p).on;
    const stretches: { startUs: number; endUs: number; hide: boolean }[] = [];
    let state = base;
    let since = 0;
    for (const e of [...lines, { tUs: D, hidden: base }]) {
      if (e.hidden === state) continue;
      if (state !== base) stretches.push({ startUs: since, endUs: e.tUs, hide: state });
      state = e.hidden;
      since = e.tUs;
    }
    const cursor: Project["edits"]["cursor"] = { ...p.edits.cursor, liveImported: true };
    let out: Project = { ...p, edits: { ...p.edits, cursor } };
    if (cursorKind(p) === "baked") return out;
    stretches.forEach((s, i) => {
      out = addCursorSection({ id: `live-cursor-${i + 1}`, ...s, clicks })(out);
    });
    return out;
  };
