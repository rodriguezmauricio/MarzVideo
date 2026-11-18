import { describe, expect, it } from "vitest";
import { formatTimer } from "./timer";

describe("formatTimer", () => {
  it("shows mm:ss under an hour", () => {
    expect(formatTimer(0)).toBe("00:00");
    expect(formatTimer(61_500_000)).toBe("01:01");
  });

  it("shows h:mm:ss past an hour", () => {
    expect(formatTimer(3_723_000_000)).toBe("1:02:03");
  });

  it("treats negative or missing time as zero", () => {
    expect(formatTimer(-5)).toBe("00:00");
    expect(formatTimer(Number.NaN)).toBe("00:00");
  });
});
