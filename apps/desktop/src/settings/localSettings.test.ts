import { describe, expect, it } from "vitest";
import { NO_DEVICE_DEFAULTS, readAiModel, readBurnCaptions, readDeviceDefaults, writeAiModel, writeBurnCaptions, writeDeviceDefaults } from "./localSettings";

class Mem implements Storage {
  m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe("local settings", () => {
  it("reads missing or broken device defaults as none", () => {
    const s = new Mem();
    expect(readDeviceDefaults(s)).toEqual(NO_DEVICE_DEFAULTS);
    s.setItem("marz.recorder.defaults", "{oops");
    expect(readDeviceDefaults(s)).toEqual(NO_DEVICE_DEFAULTS);
    expect(readDeviceDefaults(null)).toEqual(NO_DEVICE_DEFAULTS);
  });

  it("writes device defaults into every saved setup and keeps the rest of each setup", () => {
    const s = new Mem();
    s.setItem("marz.recorder.setup.0.1920x1080", JSON.stringify({ mode: "full", micId: "old", cameraOn: false, presets: [1] }));
    s.setItem("marz.recorder.setup.1.2560x1440", "broken");
    s.setItem("marz.other", "x");
    const d = writeDeviceDefaults(s, { micId: "usb", cameraOn: true });
    expect(d).toEqual({ micId: "usb", cameraId: null, cameraOn: true, systemAudio: false });
    expect(readDeviceDefaults(s)).toEqual(d);
    expect(JSON.parse(s.getItem("marz.recorder.setup.0.1920x1080")!)).toEqual({ mode: "full", micId: "usb", cameraOn: true, presets: [1] });
    expect(s.getItem("marz.recorder.setup.1.2560x1440")).toBe("broken");
    expect(s.getItem("marz.other")).toBe("x");
    writeDeviceDefaults(s, { systemAudio: true });
    expect(readDeviceDefaults(s)).toEqual({ ...d, systemAudio: true });
  });

  it("keeps the AI model and burn captions", () => {
    const s = new Mem();
    expect(readAiModel(s)).toBe("sonnet");
    writeAiModel(s, "opus");
    expect(readAiModel(s)).toBe("opus");
    expect(readBurnCaptions(s, "vertical")).toBe(true);
    writeBurnCaptions(s, "vertical", false);
    expect(readBurnCaptions(s, "vertical")).toBe(false);
  });
});
