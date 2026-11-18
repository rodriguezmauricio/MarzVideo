export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

/** Debounced autosave. A failed save stays pending and is retried, so an edit is never silently dropped.
 *  Saves never overlap: each one waits for the one before it, and flush waits for a save in flight. */
export function createAutosave(save: () => Promise<void>, delayMs: number, onStatus?: (s: SaveStatus) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  /** The save running now (and any queued behind it); null when idle. */
  let inFlight: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    if (!pending) return;
    pending = false;
    onStatus?.("saving");
    try {
      await save();
      onStatus?.(pending ? "unsaved" : "saved");
    } catch (err) {
      console.error("autosave failed, will retry", err);
      pending = true;
      onStatus?.("error");
      arm();
    }
  };

  /** Start a save now when idle (synchronously), else queue it behind the one in flight. */
  const saveNow = (): Promise<void> => {
    const next = inFlight ? inFlight.then(runOnce) : runOnce();
    const tracked: Promise<void> = next.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void saveNow();
    }, delayMs);
  };

  return {
    schedule(): void {
      pending = true;
      onStatus?.("unsaved");
      arm();
    },
    /** Save any pending edit now, after the save in flight (if any) has finished. True when
     *  everything is saved; false when the save failed (it stays pending and is retried). */
    async flush(): Promise<boolean> {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await saveNow();
      return !pending;
    },
  };
}
