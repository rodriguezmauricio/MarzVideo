import { describe, expect, test } from "vitest";
import { screenErrorText } from "./screenError";

describe("screenErrorText", () => {
  test("a missing or unsupported file (MediaError 4, also a 404) says so", () => {
    expect(screenErrorText(4)).toBe("The screen recording is missing or cannot be played. Check screen.mp4 in the project folder.");
  });
  test("a damaged file (decode error) says it is damaged", () => {
    expect(screenErrorText(3)).toBe("The screen recording is damaged and cannot be played. Check screen.mp4 in the project folder.");
  });
  test("anything else falls back to the missing sentence", () => {
    expect(screenErrorText(undefined)).toBe(screenErrorText(4));
  });
});
