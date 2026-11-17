import { beforeEach, describe, expect, it, vi } from "vitest";

const flush = vi.hoisted(() => ({ ok: true, calls: 0 }));
vi.mock("./editorStore", () => ({
  flushAutosave: async () => {
    flush.calls++;
    return flush.ok;
  },
}));

// Node has no location: the store reads ?project= at creation.
vi.stubGlobal("location", { search: "?project=demo" });
const { useAppStore } = await import("./appStore");

describe("goHome", () => {
  beforeEach(() => {
    flush.calls = 0;
    useAppStore.setState({ screen: "editor", dir: "demo" });
  });

  it("goes to Home once the last edit is saved", async () => {
    flush.ok = true;
    await useAppStore.getState().goHome();
    expect(useAppStore.getState().screen).toBe("home");
  });

  it("stays in the editor when the save failed (the strip shows Save failed. Retrying...)", async () => {
    flush.ok = false;
    await useAppStore.getState().goHome();
    expect(flush.calls).toBe(1);
    expect(useAppStore.getState()).toMatchObject({ screen: "editor", dir: "demo" });
  });
});
