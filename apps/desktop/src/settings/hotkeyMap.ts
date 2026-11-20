// The recorder's global hotkeys as combos he can rebind. The same rules as
// crates/capture/src/hotkeys.rs (Rust checks again on save); here for instant feedback.

export type ActionId =
  | "recordStop" | "pause" | "mute"
  | "preset1" | "preset2" | "preset3" | "preset4" | "preset5" | "preset6" | "preset7" | "preset8" | "preset9"
  | "zoomOut" | "layout1" | "layout2" | "layout3" | "layout4" | "layout5" | "draw" | "check" | "hideCursor";

export const ACTIONS: readonly { id: ActionId; combo: string; name: string }[] = [
  { id: "recordStop", combo: "Ctrl+Shift+R", name: "Record and stop" },
  { id: "pause", combo: "Ctrl+Shift+P", name: "Pause and resume" },
  { id: "mute", combo: "Ctrl+Shift+M", name: "Mute mic" },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({ id: `preset${n}` as ActionId, combo: `Ctrl+${n}`, name: `Zoom preset ${n}` })),
  { id: "zoomOut", combo: "Ctrl+0", name: "Zoom out" },
  { id: "layout1", combo: "Ctrl+Shift+1", name: "Layout: corner" },
  { id: "layout2", combo: "Ctrl+Shift+2", name: "Layout: side" },
  { id: "layout3", combo: "Ctrl+Shift+3", name: "Layout: camera" },
  { id: "layout4", combo: "Ctrl+Shift+4", name: "Layout: screen" },
  { id: "layout5", combo: "Ctrl+Shift+5", name: "Layout: floating" },
  { id: "draw", combo: "Ctrl+Shift+D", name: "Draw on screen" },
  { id: "check", combo: "Ctrl+Shift+K", name: "Tick next topic" },
  { id: "hideCursor", combo: "Ctrl+Shift+H", name: "Hide cursor" },
];

export type Bindings = Record<ActionId, string>;

export const DEFAULT_BINDINGS: Bindings = Object.fromEntries(ACTIONS.map((a) => [a.id, a.combo])) as Bindings;

/** Combos that belong to the editor or to Windows, with the reason shown when one is picked. */
const RESERVED: Record<string, string> = {
  "Ctrl+Z": "Ctrl+Z is the editor's undo.",
  "Ctrl+Shift+Z": "Ctrl+Shift+Z is the editor's redo.",
  "Ctrl+Y": "Ctrl+Y is the editor's redo.",
  "Ctrl+E": "Ctrl+E opens the export panel.",
  "Ctrl+C": "Ctrl+C is copy.",
  "Ctrl+V": "Ctrl+V is paste.",
  "Ctrl+X": "Ctrl+X is cut.",
  "Ctrl+A": "Ctrl+A is select all.",
  "Alt+F4": "Alt+F4 closes windows.",
};

type KeyLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** The key part of a combo from `KeyboardEvent.code` ("KeyR" -> "R", "Digit1" -> "1", "F5"); null for others. */
function keyName(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  if (m) return m[1]!;
  m = /^F([1-9]|1[0-2])$/.exec(code);
  return m ? `F${m[1]}` : null;
}

/** "Ctrl+Alt+Shift+K" for a key press (the order used everywhere), or null while only modifiers are held. */
export function comboFromEvent(e: KeyLike): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${key}`;
}

/** True when the key press is this combo. */
export const matchesCombo = (e: KeyLike, combo: string): boolean => comboFromEvent(e) === combo;

/** Why `combo` cannot be used for `id` given the other bindings, or null when it can. */
export function comboProblem(id: ActionId, combo: string, all: Bindings): string | null {
  if (!combo.startsWith("Ctrl+") && !combo.startsWith("Alt+")) return "Needs Ctrl or Alt.";
  const reserved = RESERVED[combo];
  if (reserved) return reserved;
  const other = ACTIONS.find((a) => a.id !== id && all[a.id] === combo);
  return other ? `Already used by ${other.name}.` : null;
}

/** The bindings without the ones equal to their default (what Rust stores). */
export const rebound = (all: Bindings): Partial<Bindings> =>
  Object.fromEntries(ACTIONS.filter((a) => all[a.id] !== a.combo).map((a) => [a.id, all[a.id]]));

/** "Ctrl+1 to Ctrl+9" style range for a run of actions (onboarding), or the single combo. */
export function rangeLabel(all: Bindings, ids: ActionId[]): string {
  const first = all[ids[0]!];
  const last = all[ids[ids.length - 1]!];
  return ids.length > 1 ? `${first} to ${last}` : first;
}
