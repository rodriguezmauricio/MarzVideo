import { describe, expect, it } from "vitest";
import { addPreset, defaultSetup, loadSetup, MAX_PRESETS, recordOptions, saveSetup, setupKey, type Monitor, type Setup } from "./recorderStore";

const MON: Monitor = { index: 1, name: "Test", x: 0, y: 0, width: 2880, height: 1800, scale: 2 };

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const RECT = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };

describe("setup persistence", () => {
  it("is stored per monitor and comes back", () => {
    const s = memory();
    const setup: Setup = { ...defaultSetup(MON), mode: "full", micId: "usb", cursorHidden: true };
    saveSetup(s, MON, setup);
    expect(loadSetup(s, MON)).toEqual(setup);
    expect(loadSetup(s, { ...MON, index: 0 })).toEqual(defaultSetup({ ...MON, index: 0 }));
    expect(setupKey(MON)).not.toEqual(setupKey({ ...MON, width: 1920 }));
  });

  it("falls back to the default when storage throws or holds junk", () => {
    const throwing = { ...memory(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as Storage;
    expect(loadSetup(throwing, MON)).toEqual(defaultSetup(MON));
    expect(() => saveSetup(throwing, MON, defaultSetup(MON))).not.toThrow();
    const s = memory();
    s.setItem(setupKey(MON), "{not json");
    expect(loadSetup(s, MON)).toEqual(defaultSetup(MON));
    s.setItem(setupKey(MON), JSON.stringify({ mode: "window", region: { x: "a" }, presets: [{ id: 3 }], cursorHidden: "yes" }));
    expect(loadSetup(s, MON)).toEqual(defaultSetup(MON));
  });

  it("keeps at most 9 presets", () => {
    const s = memory();
    const presets = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), name: `Zoom ${i + 1}`, rect: RECT }));
    s.setItem(setupKey(MON), JSON.stringify({ ...defaultSetup(MON), presets }));
    expect(loadSetup(s, MON).presets).toHaveLength(MAX_PRESETS);
  });

  it("defaults to a centred 16:9 region of two thirds of the monitor", () => {
    expect(defaultSetup(MON).region).toEqual({ x: 480, y: 360, w: 1920, h: 1080 });
  });
});

describe("addPreset", () => {
  it("fills the lowest free number with the default name, up to 9", () => {
    let list = addPreset([], RECT);
    list = addPreset(list, RECT);
    expect(list.map((p) => [p.id, p.name])).toEqual([["1", "Zoom 1"], ["2", "Zoom 2"]]);
    list = addPreset(list.filter((p) => p.id !== "1"), RECT);
    expect(list.map((p) => p.id)).toEqual(["1", "2"]);
    for (let i = 0; i < 10; i++) list = addPreset(list, RECT);
    expect(list).toHaveLength(9);
  });
});

describe("recordOptions", () => {
  const setup = (mode: Setup["mode"]): Setup => ({
    mode,
    region: { x: 100, y: 50, w: 1280, h: 720 },
    locked: true,
    presets: [
      { id: "2", name: "Terminal output", rect: { x: 0.5, y: 0.1, w: 0.4, h: 0.4 } },
      { id: "1", name: "Cart total", rect: { x: 0.1, y: 0.5, w: 0.3, h: 0.1 } },
    ],
    micId: "usb",
    cursorHidden: true,
    systemAudio: true,
    cameraId: "cam",
    cameraOn: true,
  });

  it("sends the camera only when it is on, and reads older saved setups as off", () => {
    expect(recordOptions(setup("region"), MON).cameraId).toBe("cam");
    expect(recordOptions({ ...setup("region"), cameraOn: false }, MON).cameraId).toBeNull();
    const st = new Map<string, string>();
    const storage = { getItem: (k: string) => st.get(k) ?? null, setItem: (k: string, v: string) => void st.set(k, v) } as unknown as Storage;
    saveSetup(storage, MON, setup("region"));
    expect(loadSetup(storage, MON)).toMatchObject({ cameraOn: true, cameraId: "cam" });
    const { cameraOn: _a, cameraId: _b, ...older } = setup("region");
    st.set(setupKey(MON), JSON.stringify(older));
    expect(loadSetup(storage, MON)).toMatchObject({ cameraOn: false, cameraId: null });
  });

  it("sends presets as p1..p9 in order, locked to 16:9 in the region", () => {
    const o = recordOptions(setup("region"), MON);
    expect(o.presets.map((p) => [p.id, p.name])).toEqual([
      ["p1", "Cart total"],
      ["p2", "Terminal output"],
    ]);
    // the region is 16:9, so a 16:9 preset has h == w in normalized units
    for (const p of o.presets) expect(p.rect.h).toBeCloseTo(p.rect.w, 9);
    expect(o).toMatchObject({ mode: "region", region: { x: 100, y: 50, w: 1280, h: 720 }, micId: "usb", systemAudio: true, cursorHidden: true });
  });

  it("keeps the computer sound choice, and reads older saved setups as off", () => {
    const st = new Map<string, string>();
    const storage = { getItem: (k: string) => st.get(k) ?? null, setItem: (k: string, v: string) => void st.set(k, v) } as unknown as Storage;
    saveSetup(storage, MON, setup("region"));
    expect(loadSetup(storage, MON).systemAudio).toBe(true);
    const { systemAudio: _drop, ...older } = setup("region");
    st.set(setupKey(MON), JSON.stringify(older));
    expect(loadSetup(storage, MON).systemAudio).toBe(false);
    expect(loadSetup(storage, MON).micId).toBe("usb");
  });

  it("locks presets to the monitor in Full screen", () => {
    const o = recordOptions({ ...setup("full"), region: { x: 0, y: 0, w: 1000, h: 1000 } }, MON);
    // 2880 x 1800 is 16:10: a 16:9 preset is h = w * 2880 / (16/9 * 1800) of the monitor
    for (const p of o.presets) expect(p.rect.h).toBeCloseTo((p.rect.w * 2880) / ((16 / 9) * 1800), 9);
  });
});
