export function createAutosave(save: () => Promise<void>, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const run = async () => {
    timer = undefined;
    pending = false;
    try {
      await save();
    } catch (err) {
      console.error("autosave failed", err);
    }
  };

  return {
    schedule(): void {
      pending = true;
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
