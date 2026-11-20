// Keypress log and on-video keys (design: docs/superpowers/specs/2026-11-19-keypress-overlay-design.md).
// `edits.keys` is an optional passthrough field: unknown values read as the defaults and are kept on save.
import type { Project } from "./project";

export const KEYS_POSITIONS = ["bottomLeft", "bottomCenter", "bottomRight", "topLeft", "topCenter", "topRight"] as const;
export const KEYS_SIZES = ["S", "M", "L"] as const;
export const KEYS_STYLES = ["ink", "paper", "accent"] as const;
export type KeysPosition = (typeof KEYS_POSITIONS)[number];
export type KeysSize = (typeof KEYS_SIZES)[number];
export type KeysStyle = (typeof KEYS_STYLES)[number];

/** One shown combo on the Keys lane (source time). `count`: presses of the same combo merged into it. */
export type KeyItem = { id: string; startUs: number; endUs: number; keys: string[]; count: number; hidden: boolean };

/** The whole-video settings as this build reads them. */
export type KeysLook = { show: boolean; position: KeysPosition; size: KeysSize; style: KeysStyle };
export const DEFAULT_KEYS_LOOK: KeysLook = { show: true, position: "bottomLeft", size: "M", style: "ink" };

const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** The raw `edits.keys` object, or an empty one. */
export function rawKeys(p: Project): Record<string, unknown> {
  const v = (p.edits as Record<string, unknown>).keys;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function keysLook(p: Project): KeysLook {
  const k = rawKeys(p);
  const d = DEFAULT_KEYS_LOOK;
  return {
    show: typeof k.show === "boolean" ? k.show : d.show,
    position: pick(k.position, KEYS_POSITIONS, d.position),
    size: pick(k.size, KEYS_SIZES, d.size),
    style: pick(k.style, KEYS_STYLES, d.style),
  };
}

/** True once the `key` lines of events.jsonl became blocks (never imported again). */
export const keysImported = (p: Project): boolean => rawKeys(p).liveImported === true;

/** The raw `edits.keys.items` list (anything), for writing it back with unknown entries kept. */
export function rawKeyItems(p: Project): unknown[] {
  const s = rawKeys(p).items;
  return Array.isArray(s) ? s : [];
}

function readItem(raw: unknown): KeyItem | null {
  const o = raw as Partial<KeyItem> | null;
  if (!o || typeof o.id !== "string" || !Number.isInteger(o.startUs) || !Number.isInteger(o.endUs) || o.endUs! <= o.startUs!) return null;
  if (!Array.isArray(o.keys) || o.keys.length === 0 || !o.keys.every((k) => typeof k === "string" && k !== "")) return null;
  const count = Number.isInteger(o.count) && o.count! >= 1 ? o.count! : 1;
  return { id: o.id, startUs: o.startUs!, endUs: o.endUs!, keys: [...o.keys], count, hidden: o.hidden === true };
}

/** The key blocks this build can read, by start time. */
export function keyItems(p: Project): KeyItem[] {
  return rawKeyItems(p)
    .map(readItem)
    .filter((x): x is KeyItem => x !== null)
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
}

/** "Ctrl+Shift+S", plus " x3" when the combo was pressed three times. */
export function keyComboLabel(item: Pick<KeyItem, "keys" | "count">): string {
  return item.keys.join("+") + (item.count > 1 ? ` x${item.count}` : "");
}
