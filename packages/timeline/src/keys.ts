import { keyItems, keysLook, rawKeyItems, rawKeys, type KeyEvent, type KeyItem, type KeysLook, type MarzEvent, type Project } from "@marz/format";
import type { Command } from "./commands";

/** How long a pressed combo shows (design: 2026-11-19-keypress-overlay-design.md). */
export const KEY_HOLD_US = 1_500_000;
/** Shortest key block. */
export const MIN_KEY_US = 100_000;

const sameCombo = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** Write the blocks (and any look patch), keeping entries this build cannot read and unknown fields. */
function withKeys(p: Project, list: KeyItem[] | null, patch: Record<string, unknown> = {}): Project {
  const raw = rawKeys(p);
  let items: unknown[] = rawKeyItems(p);
  if (list) {
    const known = new Set(keyItems(p).map((s) => s.id));
    const unknown = items.filter((s) => !known.has((s as { id?: unknown } | null)?.id as string));
    items = [...[...list].sort((a, b) => a.startUs - b.startUs), ...unknown];
  }
  return { ...p, edits: { ...p.edits, keys: { ...raw, ...patch, items } } };
}

/** Turn the `key` lines of events.jsonl into Keys blocks, once per project (`liveImported`). Each press
 *  shows for `KEY_HOLD_US`; the same combo again while it shows adds to `count` and extends the block; a
 *  different combo ends the block before it. Returns `p` when the take has no key lines. */
export const importLiveKeys =
  (events: MarzEvent[]): Command =>
  (p) => {
    if (rawKeys(p).liveImported === true) return p;
    const presses = events.filter((e): e is KeyEvent => e.type === "key").sort((a, b) => a.tUs - b.tUs);
    if (presses.length === 0) return p;
    const D = p.durationUs;
    const out: KeyItem[] = [];
    let cur: KeyItem | null = null;
    const close = (at: number) => {
      if (!cur) return;
      cur.endUs = Math.min(cur.endUs, at, D);
      if (cur.endUs - cur.startUs >= MIN_KEY_US) out.push(cur);
      cur = null;
    };
    let n = 0;
    for (const e of presses) {
      const t = Math.max(0, e.tUs);
      if (t >= D) break;
      if (cur && t < (cur as KeyItem).endUs && sameCombo((cur as KeyItem).keys, e.keys)) {
        (cur as KeyItem).count += 1;
        (cur as KeyItem).endUs = t + KEY_HOLD_US;
        continue;
      }
      close(t);
      n += 1;
      cur = { id: `key-${n}`, startUs: t, endUs: t + KEY_HOLD_US, keys: [...e.keys], count: 1, hidden: false };
    }
    close(D);
    return withKeys(p, out, { liveImported: true });
  };

/** Change a block's time or its hidden switch, kept between its neighbours and at least `MIN_KEY_US` long. */
export const updateKeyItem =
  (id: string, patch: Partial<Pick<KeyItem, "startUs" | "endUs" | "hidden">>): Command =>
  (p) => {
    const list = keyItems(p);
    const cur = list.find((x) => x.id === id);
    if (!cur) return p;
    const others = list.filter((x) => x.id !== id);
    const prevEnd = others.filter((x) => x.startUs < cur.startUs).reduce((m, x) => Math.max(m, x.endUs), 0);
    const nextStart = others.filter((x) => x.startUs >= cur.startUs).reduce((m, x) => Math.min(m, x.startUs), p.durationUs);
    const len = cur.endUs - cur.startUs;
    const isMove = patch.startUs !== undefined && patch.endUs !== undefined && patch.endUs - patch.startUs === len;
    const startUs = isMove
      ? Math.max(prevEnd, Math.min(patch.startUs!, nextStart - len))
      : Math.max(prevEnd, Math.min(patch.startUs ?? cur.startUs, nextStart - MIN_KEY_US));
    const endUs = isMove ? startUs + len : Math.min(nextStart, Math.max(patch.endUs ?? cur.endUs, startUs + MIN_KEY_US));
    const hidden = patch.hidden ?? cur.hidden;
    if (startUs === cur.startUs && endUs === cur.endUs && hidden === cur.hidden) return p;
    return withKeys(p, [...others, { ...cur, startUs, endUs, hidden }]);
  };

export const removeKeyItem =
  (id: string): Command =>
  (p) => {
    const list = keyItems(p);
    if (!list.some((x) => x.id === id)) return p;
    return withKeys(p, list.filter((x) => x.id !== id));
  };

/** Change the whole-video look: show, position, size, style. */
export const setKeys =
  (patch: Partial<KeysLook>): Command =>
  (p) => {
    const cur = keysLook(p);
    const next = { ...cur, ...patch };
    if (next.show === cur.show && next.position === cur.position && next.size === cur.size && next.style === cur.style) return p;
    return withKeys(p, null, next);
  };
