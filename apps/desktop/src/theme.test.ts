import { describe, expect, it } from "vitest";
import { nextTheme, parseTheme, resolveTheme } from "./theme";

describe("theme choice", () => {
  it("defaults to dark for missing or unknown values", () => {
    expect(parseTheme(null)).toBe("dark");
    expect(parseTheme("blue")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("system")).toBe("system");
  });

  it("cycles dark, light, Windows", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
    expect(nextTheme("system")).toBe("dark");
  });

  it("follows Windows only for the system choice", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });
});
