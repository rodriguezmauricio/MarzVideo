export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

/** Debounced autosave. A failed save stays pending and is retried, so an edit is never silently dropped. */
export function createAutosave(save: () => Promise<void>, delayMs: number, onStatus?: (s: SaveStatus) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const run = async () => {
    timer = undefined;
    pending = false;
    onStatus?.("saving");
    try {
      await save();
      onStatus?.("saved");
    } catch (err) {
      console.error("autosave failed, will retry", err);
      pending = true;
      onStatus?.("error");
      timer = setTimeout(run, delayMs);
    }
  };

  return {
    schedule(): void {
      pending = true;
      onStatus?.("unsaved");
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    async flush(): Promise<void> {
      if (!pending) return;
      if (timer !== undefined) clearTimeout(timer);
      await run();
    },
  };
}
