// AI checklist edits (docs/superpowers/specs/2026-11-19-ai-checklist-design.md): import the live
// `checklist` lines once, mark or clear a topic in the editor, cover open topics the matcher found.
import { checklistEdits, checklistItems, readChecklistItem, type ChecklistBy, type ChecklistEvent, type MarzEvent, type Project } from "@marz/format";
import type { Command } from "./commands";

const withItems = (p: Project, items: unknown[], extra: object = {}): Project => ({
  ...p,
  edits: { ...p.edits, checklist: { ...checklistEdits(p), ...extra, items } },
});

/** The topics and their live ticks become `edits.checklist` the first time the take opens. The
 *  first tick of a topic wins; times are kept inside the recording. */
export const importLiveChecklist =
  (events: MarzEvent[]): Command =>
  (p) => {
    if (checklistEdits(p).liveImported) return p;
    const lines = events.filter((e): e is ChecklistEvent => e.type === "checklist");
    const listLine = lines.find((e) => e.op === "list");
    if (!listLine || listLine.op !== "list" || listLine.items.length === 0) return p;
    const items = listLine.items.map((i) => ({ id: i.id, text: i.text, atUs: null as number | null, by: undefined as ChecklistBy | undefined }));
    for (const e of lines) {
      if (e.op !== "tick") continue;
      const it = items.find((i) => i.id === e.id);
      if (!it || it.atUs !== null) continue;
      it.atUs = Math.min(p.durationUs, Math.max(0, e.atUs));
      it.by = e.by;
    }
    return withItems(
      p,
      items.map((i) => (i.atUs === null ? { id: i.id, text: i.text, atUs: null } : { id: i.id, text: i.text, atUs: i.atUs, by: i.by })),
      { liveImported: true },
    );
  };

/** Change raw item `id` in place (other fields and unreadable items stay); no-op when not changed. */
const mapItem = (p: Project, id: string, f: (raw: Record<string, unknown>) => Record<string, unknown> | null): Project => {
  const raw = checklistEdits(p).items;
  let changed = false;
  const items = raw.map((r) => {
    const it = readChecklistItem(r);
    if (!it || it.id !== id) return r;
    const next = f(r as Record<string, unknown>);
    if (!next) return r;
    changed = true;
    return next;
  });
  return changed ? withItems(p, items) : p;
};

/** Topic `id` covered at `atUs`. */
export const coverChecklistItem =
  (id: string, atUs: number, by: ChecklistBy): Command =>
  (p) =>
    mapItem(p, id, (r) => ({ ...r, atUs: Math.min(p.durationUs, Math.max(0, Math.round(atUs))), by }));

/** Topic `id` open again. */
export const clearChecklistItem =
  (id: string): Command =>
  (p) =>
    mapItem(p, id, (r) => {
      if (r.atUs === null || r.atUs === undefined) return null;
      const { by: _by, ...rest } = r;
      return { ...rest, atUs: null };
    });

/** Cover the topics found (by the matcher) that are still open; covered ones keep their time. */
export const coverOpenItems =
  (hits: { id: string; atUs: number }[], by: ChecklistBy): Command =>
  (p) => {
    const open = new Set(checklistItems(p).filter((i) => i.atUs === null).map((i) => i.id));
    return hits.filter((h) => open.has(h.id)).reduce((acc, h) => coverChecklistItem(h.id, h.atUs, by)(acc), p);
  };
