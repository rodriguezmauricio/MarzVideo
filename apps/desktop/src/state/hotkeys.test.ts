import { describe, expect, test } from "vitest";
import { ignoredRepeat } from "./hotkeys";

const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe("ignoredRepeat", () => {
  test("a held add key (Z, C, L, H, F, A) fires once", () => {
    for (const code of ["KeyZ", "KeyC", "KeyL", "KeyH", "KeyF", "KeyA", "Space"]) expect(ignoredRepeat(key(code, { repeat: true }))).toBe(true);
  });
  test("the first press is never ignored", () => {
    expect(ignoredRepeat(key("KeyZ"))).toBe(false);
  });
  test("held Ctrl+Z keeps undoing", () => {
    expect(ignoredRepeat(key("KeyZ", { repeat: true, ctrlKey: true }))).toBe(false);
  });
});
