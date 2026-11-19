import { describe, expect, it } from "vitest";
import { parseArchiveState } from "@marz/format";
import { withMedia } from "./withMedia";
import type { ProjectStorage } from "./types";

const base: ProjectStorage = {
  readText: async (p) => `text of ${p}`,
  fileUrl: (p) => `asset://x/${p}`,
  writeProjectJson: async () => {},
};

describe("withMedia", () => {
  it("serves the proxy for a removed raw file and everything else as it is", async () => {
    const s = withMedia(base, parseArchiveState({ proxies: { "screen.mp4": "proxies/screen.mp4" }, removed: ["screen.mp4"] }));
    expect(s.fileUrl("screen.mp4")).toBe("asset://x/proxies/screen.mp4");
    expect(s.fileUrl("mic.wav")).toBe("asset://x/mic.wav");
    expect(await s.readText("project.json")).toBe("text of project.json");
  });
});
