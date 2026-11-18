// Shared start-up for the two recorder windows: monitor, persisted setup, cross-window sync.
import { initLive } from "./recLive";
import { isFake, recorderApi } from "./recorderApi";
import { defaultSetup, loadSetup, localStore, setupKey, useRecorder, type Mode, type Setup } from "./recorderStore";

/** Fake mode: the mockup's sample (region 960 x 540 at 240, 130 in CSS pixels, two presets). */
function fakeSetup(): Setup {
  const mode = new URLSearchParams(window.location.search).get("mode") as Mode | null;
  return {
    mode: mode === "full" || mode === "exact" ? mode : "region",
    region: { x: 480, y: 260, w: 1920, h: 1080 },
    locked: true,
    presets: [
      { id: "1", name: "Cart total", rect: { x: 60 / 960, y: 280 / 540, w: 320 / 960, h: 180 / 540 } },
      { id: "2", name: "Terminal output", rect: { x: 520 / 960, y: 60 / 540, w: 400 / 960, h: 225 / 540 } },
    ],
    micId: null,
    cursorHidden: false,
  };
}

export function initSetup(): void {
  const api = recorderApi();
  const m = api.monitor;
  initLive();
  if (isFake()) {
    useRecorder.getState().init(m, fakeSetup(), false);
    return;
  }
  const st = localStore();
  useRecorder.getState().init(m, st ? loadSetup(st, m) : defaultSetup(m), true);
  // The other recorder window saved: take its setup.
  window.addEventListener("storage", (e) => {
    if (e.key === setupKey(m)) useRecorder.getState().reload();
  });
}
