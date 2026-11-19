import { describe, expect, it } from "vitest";
import { mediaFile, parseArchiveState, storageLabel, EMPTY_ARCHIVE_STATE } from "./archive";

describe("parseArchiveState", () => {
  it("reads nothing as the empty state", () => {
    expect(parseArchiveState(null)).toEqual(EMPTY_ARCHIVE_STATE);
    expect(parseArchiveState("junk")).toEqual(EMPTY_ARCHIVE_STATE);
  });

  it("reads the manifest, proxies and removed files", () => {
    const s = parseArchiveState({
      archive: { dir: "G:/My Drive/Marz Recorder/A.marz", at: "2026-11-19T18:00:00Z", files: [{ path: "screen.mp4", size: 10, sha256: "ab" }, "junk"] },
      proxies: { "screen.mp4": "proxies/screen.mp4", "camera.mp4": 3 },
      removed: ["screen.mp4", 4],
      later: true,
    });
    expect(s.archive?.dir).toBe("G:/My Drive/Marz Recorder/A.marz");
    expect(s.archive?.files).toEqual([{ path: "screen.mp4", size: 10, sha256: "ab" }]);
    expect(s.proxies).toEqual({ "screen.mp4": "proxies/screen.mp4" });
    expect(s.removed).toEqual(["screen.mp4"]);
  });

  it("drops an archive without a folder", () => {
    expect(parseArchiveState({ archive: { files: [] } }).archive).toBeNull();
  });
});

describe("mediaFile", () => {
  const removed = parseArchiveState({ proxies: { "screen.mp4": "proxies/screen.mp4" }, removed: ["screen.mp4", "camera.mp4"] });

  it("keeps the raw file while it is here", () => {
    expect(mediaFile(EMPTY_ARCHIVE_STATE, "screen.mp4")).toBe("screen.mp4");
    expect(mediaFile(removed, "mic.wav")).toBe("mic.wav");
  });

  it("uses the proxy once the raw file is removed", () => {
    expect(mediaFile(removed, "screen.mp4")).toBe("proxies/screen.mp4");
  });

  it("keeps the raw name when a removed file has no proxy (the player shows the missing file)", () => {
    expect(mediaFile(removed, "camera.mp4")).toBe("camera.mp4");
  });
});

describe("storageLabel", () => {
  it("names the state for Home", () => {
    expect(storageLabel(EMPTY_ARCHIVE_STATE)).toBeNull();
    expect(storageLabel(parseArchiveState({ archive: { dir: "D:/a", at: "t", files: [] } }))).toBe("archived");
    expect(storageLabel(parseArchiveState({ archive: { dir: "D:/a", at: "t", files: [] }, removed: ["screen.mp4"] }))).toBe("rawRemoved");
  });
});
