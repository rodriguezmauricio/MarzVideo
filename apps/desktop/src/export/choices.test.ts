import { describe, expect, it } from "vitest";
import { DEFAULT_CHOICES, fpsAllowed, readChoices, resolvePreset, writeChoices } from "./choices";
import { encoderConfig, hevcKey, hevcSupportedAt, pickCodecConfig } from "./encoderConfig";
import { presetSize } from "./exportUi";
import { PRESETS } from "./presets";

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

describe("export choices", () => {
  it("the defaults are the M1 presets, unchanged", () => {
    const yt = resolvePreset(PRESETS.youtube, DEFAULT_CHOICES, 60);
    expect([yt.width, yt.height, yt.fps(60), yt.bitrate(60), yt.codec]).toEqual([1920, 1080, 60, 12_000_000, "h264"]);
    expect(yt.frameRect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    const v = resolvePreset(PRESETS.vertical, DEFAULT_CHOICES, 60);
    expect([v.width, v.height, v.fps(60), v.bitrate(30), v.frameRect]).toEqual([1080, 1920, 30, 6_000_000, PRESETS.vertical.frameRect]);
    expect(presetSize(yt, 60)).toBe("1920 x 1080, 60 fps");
    expect(presetSize(v, 60)).toBe("1080 x 1920, 30 fps");
  });

  it("landscape sizes change the picture and the bitrate", () => {
    const s720 = resolvePreset(PRESETS.youtube, { codec: "h264", size: "720p", fps: 30 }, 60);
    expect([s720.width, s720.height, s720.fps(60), s720.bitrate(30)]).toEqual([1280, 720, 30, 5_000_000]);
    expect(s720.frameRect).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    const s1440 = resolvePreset(PRESETS.youtube, { codec: "h264", size: "1440p", fps: null }, 60);
    expect([s1440.width, s1440.height, s1440.fps(60), s1440.bitrate(60)]).toEqual([2560, 1440, 60, 24_000_000]);
    expect(presetSize(s1440, 60)).toBe("2560 x 1440, 60 fps");
  });

  it("the vertical preset keeps its size whatever size is remembered", () => {
    const v = resolvePreset(PRESETS.vertical, { codec: "h264", size: "1440p", fps: 60 }, 60);
    expect([v.width, v.height, v.fps(60), v.bitrate(60)]).toEqual([1080, 1920, 60, 9_000_000]);
  });

  it("the frame rate is capped at the recording's rate", () => {
    expect(fpsAllowed(60, 30)).toBe(false);
    expect(fpsAllowed(30, 30)).toBe(true);
    expect(fpsAllowed(60, 59.94)).toBe(true);
    const yt = resolvePreset(PRESETS.youtube, { codec: "h264", size: "1080p", fps: 60 }, 30);
    expect(yt.fps(30)).toBe(30);
    expect(resolvePreset(PRESETS.youtube, { codec: "h264", size: "1080p", fps: 24 }, 60).fps(60)).toBe(24);
  });

  it("HEVC uses 60 percent of the H.264 bitrate and says so on the row", () => {
    const h = resolvePreset(PRESETS.youtube, { codec: "hevc", size: "1080p", fps: null }, 60);
    expect(h.codec).toBe("hevc");
    expect(h.bitrate(60)).toBe(7_200_000);
    expect(presetSize(h, 60)).toBe("1920 x 1080, 60 fps, HEVC");
  });

  it("are remembered per preset; bad or missing values fall back to the defaults", () => {
    const st = memoryStorage();
    expect(readChoices(st, "youtube")).toEqual(DEFAULT_CHOICES);
    writeChoices(st, "youtube", { codec: "hevc", size: "1440p", fps: 24 });
    expect(readChoices(st, "youtube")).toEqual({ codec: "hevc", size: "1440p", fps: 24 });
    expect(readChoices(st, "vertical")).toEqual(DEFAULT_CHOICES);
    st.setItem("marz.export.choices.vertical", '{"codec":"av1","size":"8k","fps":13}');
    expect(readChoices(st, "vertical")).toEqual(DEFAULT_CHOICES);
    st.setItem("marz.export.choices.vertical", "not json");
    expect(readChoices(st, "vertical")).toEqual(DEFAULT_CHOICES);
    expect(readChoices(null, "vertical")).toEqual(DEFAULT_CHOICES);
  });
});

describe("encoder config per codec", () => {
  it("names the codec and level by codec and height", () => {
    const at = (codec: "h264" | "hevc", size: "720p" | "1080p" | "1440p") => resolvePreset(PRESETS.youtube, { codec, size, fps: null }, 60);
    expect(encoderConfig(at("h264", "1080p"), 60)).toMatchObject({ codec: "avc1.640028", avc: { format: "annexb" } });
    expect(encoderConfig(at("h264", "1440p"), 60)).toMatchObject({ codec: "avc1.640033", width: 2560, height: 1440 });
    const hevc = encoderConfig(at("hevc", "1080p"), 60);
    expect(hevc).toMatchObject({ codec: "hvc1.1.6.L123.B0", hevc: { format: "annexb" } });
    expect("avc" in hevc).toBe(false);
    expect(encoderConfig(at("hevc", "1440p"), 60).codec).toBe("hvc1.1.6.L153.B0");
    // The vertical picture is 1920 tall but 1080 wide: same pixel count as 1080p.
    expect(encoderConfig(resolvePreset(PRESETS.vertical, { codec: "hevc", size: "1080p", fps: null }, 60), 30).codec).toBe("hvc1.1.6.L123.B0");
  });

  it("falls back from HEVC to H.264 and says it did", async () => {
    const hevc = resolvePreset(PRESETS.youtube, { codec: "hevc", size: "1080p", fps: null }, 60);
    const got = await pickCodecConfig(hevc, 60, async (c) => c.codec.startsWith("avc1"));
    expect(got?.codec).toBe("h264");
    expect(got?.config.codec).toBe("avc1.640028");
    expect(got?.config.bitrate).toBe(12_000_000);
    const kept = await pickCodecConfig(hevc, 60, async () => true);
    expect(kept?.codec).toBe("hevc");
    expect(await pickCodecConfig(hevc, 60, async () => false)).toBeNull();
  });

  it("asks about HEVC at the export's own size and rate (this laptop: 1080p at 30 fps at most)", async () => {
    const laptop = async (c: VideoEncoderConfig) => !c.codec.startsWith("hvc1") || (c.width * c.height <= 1920 * 1080 && (c.framerate ?? 0) <= 30);
    expect(await hevcSupportedAt({ width: 1920, height: 1080 }, 30, laptop)).toBe(true);
    expect(await hevcSupportedAt({ width: 1080, height: 1920 }, 30, laptop)).toBe(true);
    expect(await hevcSupportedAt({ width: 1920, height: 1080 }, 60, laptop)).toBe(false);
    expect(await hevcSupportedAt({ width: 2560, height: 1440 }, 30, laptop)).toBe(false);
    expect(hevcKey({ width: 2560, height: 1440 }, 60)).toBe("2560x1440@60");
  });
});
