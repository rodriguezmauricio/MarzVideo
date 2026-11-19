import { backgroundEdits, rawBackground, type BackgroundEdits } from "@marz/format";
import type { Command } from "./commands";

/** Change the project background (`edits.background`), keeping fields this build cannot read.
 *  Returns `p` when nothing changes. */
export const setBackground =
  (patch: Partial<BackgroundEdits>): Command =>
  (p) => {
    const cur = backgroundEdits(p);
    if (Object.entries(patch).every(([k, v]) => cur[k as keyof BackgroundEdits] === v)) return p;
    return { ...p, edits: { ...p.edits, background: { ...rawBackground(p), ...patch } } };
  };
