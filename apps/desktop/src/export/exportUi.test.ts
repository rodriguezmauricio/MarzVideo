import { describe, expect, it } from "vitest";
import { pickEncoderConfig } from "./encoderConfig";
import { copyNote, doneLead, hevcNote, failureText, folderName, panelKey, percent, presetSize, readLastPreset, writeLastPreset } from "./exportUi";
import { PRESETS } from "./presets";
import { ExportFailure } from "./tauriSink";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe("preset panel keys", () => {
  it("Enter picks the highlighted row, which starts on the last used one", () => {
    expect(panelKey({ open: true, highlight: "vertical" }, "Enter")).toEqual({ open: false, highlight: "vertical", pick: "vertical" });
  });
  it("arrows move the highlight between the two rows", () => {
    expect(panelKey({ open: true, highlight: "youtube" }, "ArrowDown")).toEqual({ open: true, highlight: "vertical" });
    expect(panelKey({ open: true, highlight: "vertical" }, "ArrowDown")).toEqual({ open: true, highlight: "youtube" });
    expect(panelKey({ open: true, highlight: "youtube" }, "ArrowUp")).toEqual({ open: true, highlight: "vertical" });
  });
  it("Esc closes without picking; other keys are ignored", () => {
    expect(panelKey({ open: true, highlight: "youtube" }, "Escape")).toEqual({ open: false, highlight: "youtube" });
    expect(panelKey({ open: true, highlight: "youtube" }, "KeyZ")).toBeNull();
  });
  it("does nothing while closed", () => {
    expect(panelKey({ open: false, highlight: "youtube" }, "Enter")).toBeNull();
  });
});

describe("last used preset", () => {
  it("is YouTube the first time and remembers the last pick", () => {
    const s = memoryStorage();
    expect(readLastPreset(s)).toBe("youtube");
    writeLastPreset(s, "vertical");
    expect(readLastPreset(s)).toBe("vertical");
  });
  it("ignores junk and storage that throws", () => {
    const s = memoryStorage();
    s.setItem("marz.export.preset", "dvd");
    expect(readLastPreset(s)).toBe("youtube");
    const broken = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readLastPreset(broken)).toBe("youtube");
    expect(() => writeLastPreset(broken, "vertical")).not.toThrow();
    expect(readLastPreset(null)).toBe("youtube");
  });
});

describe("export copy", () => {
  it("sizes show the fps the export uses", () => {
    expect(presetSize(PRESETS.youtube, 60)).toBe("1920 x 1080, 60 fps");
    expect(presetSize(PRESETS.youtube, 30)).toBe("1920 x 1080, 30 fps");
    expect(presetSize(PRESETS.youtube, 144)).toBe("1920 x 1080, 60 fps");
    expect(presetSize(PRESETS.vertical, 60)).toBe("1080 x 1920, 30 fps");
  });
  it("the done line names the copy folder and an HEVC fallback", () => {
    expect(folderName(String.raw`D:\MarzOS\Inbox`)).toBe("Inbox");
    expect(folderName(String.raw`D:\MarzOS\Inbox\ `.trim())).toBe("Inbox");
    expect(folderName("/home/m/drop")).toBe("drop");
    expect(folderName(String.raw`E:\ `.trim())).toBe("E:");
    expect(copyNote(String.raw`D:\MarzOS\Inbox`, true)).toBe("Copied to Inbox.");
    expect(copyNote(String.raw`D:\MarzOS\Inbox`, false)).toBe("Could not copy to Inbox.");
    expect(doneLead("h264", "h264")).toBe("Exported.");
    expect(doneLead("hevc", "hevc")).toBe("Exported.");
    expect(doneLead("hevc", "h264")).toBe("Exported as H.264. HEVC is not available.");
  });
  it("says plainly when HEVC cannot be used", () => {
    expect(hevcNote("no", undefined)).toBe("HEVC is not available on this computer. Exports use H.264.");
    expect(hevcNote("yes", false)).toBe("HEVC is not available at this size and frame rate. This export uses H.264.");
    expect(hevcNote("yes", true)).toBeNull();
    expect(hevcNote("unknown", undefined)).toBeNull();
  });
  it("progress is a whole percent from 0 to 100", () => {
    expect(percent(0)).toBe(0);
    expect(percent(0.429)).toBe(42);
    expect(percent(1)).toBe(100);
    expect(percent(1.2)).toBe(100);
    expect(percent(Number.NaN)).toBe(0);
  });
  it("failures become the warning bar sentence", () => {
    expect(failureText(new ExportFailure("FFmpeg is missing. Install it or set MARZ_FFMPEG", "x"))).toBe(
      "Export failed. FFmpeg is missing. Install it or set MARZ_FFMPEG. Your project is unchanged.",
    );
    expect(failureText(new Error("This computer cannot encode H.264 video"))).toBe(
      "Export failed. This computer cannot encode H.264 video. Your project is unchanged.",
    );
    expect(failureText(new Error("VideoDecoder: decode failed at 12"))).toBe(
      "Export failed. The video could not be encoded. Your project is unchanged.",
    );
    expect(failureText("weird")).toBe("Export failed. The video could not be encoded. Your project is unchanged.");
  });
});

describe("encoder config", () => {
  it("prefers hardware", async () => {
    const tried: string[] = [];
    const c = await pickEncoderConfig(PRESETS.youtube, 60, async (cfg) => {
      tried.push(cfg.hardwareAcceleration!);
      return true;
    });
    expect(c?.hardwareAcceleration).toBe("prefer-hardware");
    expect(tried).toEqual(["prefer-hardware"]);
  });
  it("falls back to no-preference when hardware is not supported", async () => {
    const tried: string[] = [];
    const c = await pickEncoderConfig(PRESETS.vertical, 30, async (cfg) => {
      tried.push(cfg.hardwareAcceleration!);
      return cfg.hardwareAcceleration === "no-preference";
    });
    expect(tried).toEqual(["prefer-hardware", "no-preference"]);
    expect(c).toMatchObject({ codec: "avc1.640028", width: 1080, height: 1920, framerate: 30, bitrate: 6_000_000, hardwareAcceleration: "no-preference" });
  });
  it("gives null when neither works", async () => {
    expect(await pickEncoderConfig(PRESETS.youtube, 30, async () => false)).toBeNull();
  });
});
