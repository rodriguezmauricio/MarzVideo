import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createAutosave } from "./autosave";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("several schedule calls within the delay produce one save", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const a = createAutosave(save, 2000);
  a.schedule();
  vi.advanceTimersByTime(1000);
  a.schedule();
  vi.advanceTimersByTime(1000);
  expect(save).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(save).toHaveBeenCalledTimes(1);
});

test("flush saves immediately and cancels the timer", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const a = createAutosave(save, 2000);
  a.schedule();
  await a.flush();
  expect(save).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5000);
  expect(save).toHaveBeenCalledTimes(1);
});

test("flush with nothing pending does not save", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const a = createAutosave(save, 2000);
  await a.flush();
  expect(save).not.toHaveBeenCalled();
});

test("a failing save does not break later saves", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
  const a = createAutosave(save, 100);
  a.schedule();
  await vi.advanceTimersByTimeAsync(100);
  a.schedule();
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(2);
});

test("a failed save stays pending so flush retries it", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
  const a = createAutosave(save, 100);
  a.schedule();
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(1);
  await a.flush();
  expect(save).toHaveBeenCalledTimes(2);
});

test("a failed save is retried automatically", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
  const a = createAutosave(save, 100);
  a.schedule();
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(2);
});

test("status goes saving, saved, and error on failure", async () => {
  const seen: string[] = [];
  const save = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
  const a = createAutosave(save, 100, (s) => seen.push(s));
  a.schedule();
  await vi.advanceTimersByTimeAsync(100);
  expect(seen).toEqual(["unsaved", "saving", "error"]);
  await vi.advanceTimersByTimeAsync(100);
  expect(seen).toEqual(["unsaved", "saving", "error", "saving", "saved"]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("flush waits for a save already running and never starts a second one alongside it", async () => {
  const first = deferred();
  let running = 0;
  let maxRunning = 0;
  const save = vi.fn(async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    if (save.mock.calls.length === 1) await first.promise;
    running--;
  });
  const a = createAutosave(save, 100);
  a.schedule();
  await vi.advanceTimersByTimeAsync(100);
  expect(save).toHaveBeenCalledTimes(1); // first save is in flight
  a.schedule(); // an edit while it runs
  let flushed = false;
  const f = a.flush().then(() => (flushed = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(1);
  expect(flushed).toBe(false);
  first.resolve();
  await f;
  expect(save).toHaveBeenCalledTimes(2);
  expect(maxRunning).toBe(1);
});

test("flush with no new edit still waits for the save in flight", async () => {
  const first = deferred();
  const save = vi.fn(() => first.promise);
  const a = createAutosave(save, 100);
  a.schedule();
  await vi.advanceTimersByTimeAsync(100);
  let flushed = false;
  const f = a.flush().then(() => (flushed = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(flushed).toBe(false);
  first.resolve();
  await f;
  expect(save).toHaveBeenCalledTimes(1);
});
