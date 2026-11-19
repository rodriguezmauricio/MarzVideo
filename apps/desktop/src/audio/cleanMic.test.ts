import { describe, expect, it } from "vitest";
import { cleanLine, previewMicFile, type CleanState } from "./cleanMic";

const ready: CleanState = { status: "ready", dir: "C:\\a.marz", file: "cache/mic.clean.wav" };

describe("previewMicFile", () => {
  it("plays the cleaned copy only when it is ready for this project and noise removal is on", () => {
    expect(previewMicFile(ready, "C:\\a.marz", "mic.wav", true)).toBe("cache/mic.clean.wav");
    expect(previewMicFile(ready, "C:\\a.marz", "mic.wav", false)).toBe("mic.wav");
    expect(previewMicFile(ready, "C:\\b.marz", "mic.wav", true)).toBe("mic.wav");
    expect(previewMicFile({ status: "cleaning", dir: "C:\\a.marz" }, "C:\\a.marz", "mic.wav", true)).toBe("mic.wav");
    expect(previewMicFile({ status: "browser" }, "demo", "mic.wav", true)).toBe("mic.wav");
  });
});

describe("cleanLine", () => {
  it("names each state in plain words", () => {
    expect(cleanLine(ready, true)).toBe("Mic cleaned. Preview plays it");
    expect(cleanLine({ status: "cleaning", dir: "x" }, true)).toBe("Cleaning mic sound");
    expect(cleanLine({ status: "browser" }, true)).toMatch(/original mic in the browser/);
    expect(cleanLine({ status: "failed", dir: "x", error: "e" }, true)).toMatch(/original/);
    expect(cleanLine(ready, false)).toBe("Preview and export use the original mic");
  });
});
