/** True for a key held down (auto-repeat) without Ctrl, Cmd or Alt: the bare editor hotkeys act once
 *  per press, so holding Z or C never stacks duplicate blocks. Held Ctrl+Z / Ctrl+Y still repeat. */
export function ignoredRepeat(e: Pick<KeyboardEvent, "repeat" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey;
}
