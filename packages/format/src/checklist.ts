import { z } from "zod";
import type { Project } from "./project";

/** AI checklist (docs/superpowers/specs/2026-11-19-ai-checklist-design.md). `edits.checklist` is an
 * optional passthrough field: nothing here changes how `project.json` is parsed, so an item this
 * build cannot read stays in the file as it is. Use `checklistItems` for the readable ones. */

export const CHECKLIST_MAX = 12;
export const CHECKLIST_TEXT_MAX = 120;

/** How a topic was ticked: live local match, Claude, Ctrl+Shift+K, the AI pass transcript, the editor. */
export const CHECKLIST_BY = ["auto", "ai", "hand", "transcript", "editor"] as const;
export type ChecklistBy = (typeof CHECKLIST_BY)[number];

export type ChecklistItem = {
  id: string;
  text: string;
  /** Source time the topic was covered; null while it is open. */
  atUs: number | null;
  by?: ChecklistBy;
};

export type ChecklistEdits = { items: unknown[]; liveImported?: boolean };

/** The topics typed on the setup bar: one per line, trimmed, empty lines dropped, 12 of 120 characters. */
export function splitTopics(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, CHECKLIST_MAX)
    .map((l) => l.slice(0, CHECKLIST_TEXT_MAX));
}

const ItemSchema = z
  .object({ id: z.string(), text: z.string(), atUs: z.number().int().nullable().optional(), by: z.string().optional() })
  .passthrough();

/** One raw item; null when this build cannot read it. An unknown `by` is dropped. */
export function readChecklistItem(raw: unknown): ChecklistItem | null {
  const r = ItemSchema.safeParse(raw);
  if (!r.success) return null;
  const out: ChecklistItem = { id: r.data.id, text: r.data.text, atUs: r.data.atUs ?? null };
  if (out.atUs !== null && (CHECKLIST_BY as readonly string[]).includes(r.data.by ?? "")) out.by = r.data.by as ChecklistBy;
  return out;
}

/** `edits.checklist` as stored, or an empty one. */
export function checklistEdits(p: Project): ChecklistEdits {
  const c = (p.edits as Record<string, unknown>).checklist as { items?: unknown; liveImported?: unknown } | undefined;
  if (!c || typeof c !== "object") return { items: [] };
  const out: ChecklistEdits = { ...(c as object), items: Array.isArray(c.items) ? c.items : [] };
  if (typeof c.liveImported === "boolean") out.liveImported = c.liveImported;
  return out;
}

/** The topics this build can show, in list order. */
export function checklistItems(p: Project): ChecklistItem[] {
  return checklistEdits(p)
    .items.map(readChecklistItem)
    .filter((i): i is ChecklistItem => i !== null);
}

export const hasChecklist = (p: Project): boolean => checklistItems(p).length > 0;
