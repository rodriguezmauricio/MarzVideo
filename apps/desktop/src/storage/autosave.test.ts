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
