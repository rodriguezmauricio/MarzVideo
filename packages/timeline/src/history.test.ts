import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CAMERA_EDITS, parseProject, type Cut, type Project, type Zoom } from "@marz/format";
import { History } from "./history";
import {
  addCut, addZoom, removeCut, removeZoom, replaceAutoZooms, setCursorHidden, updateCamera, updateCut, updateZoom,
} from "./commands";

const zoom = (id: string, origin: Zoom["origin"] = "manual"): Zoom => ({
  id, startUs: 1_000_000, endUs: 3_000_000, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
  easeInUs: 400_000, easeOutUs: 400_000, easing: "easeInOutCubic", origin,
});
const cut = (id: string): Cut => ({ id, startUs: 5_000_000, endUs: 6_000_000 });

const base = (): Project =>
  parseProject({
    version: 1, id: "p", name: "n", createdAt: "2026-11-15T00:00:00Z", durationUs: 10_000_000,
    source: { width: 1920, height: 1080, fps: 30 },
    tracks: { screen: { file: "screen.mp4", offsetUs: 0 } },
    output: { width: 1920, height: 1080, fps: 30 },
    futureThing: { keep: true },
    edits: { zooms: [], cuts: [], cursor: { hidden: false }, clicks: { effect: "none" } },
  });

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

describe("History", () => {
  test("undo restores the exact previous object and redo reapplies", () => {
    const h = new History(base());
    const first = h.current;
    h.apply(addZoom(zoom("a")));
    const second = h.current;
    expect(second).not.toBe(first);
    h.undo();
    expect(h.current).toBe(first);
    h.redo();
    expect(h.current).toBe(second);
  });

  test("applying after an undo drops redo", () => {
    const h = new History(base());
    h.apply(addZoom(zoom("a")));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.apply(addZoom(zoom("b")));
    expect(h.canRedo).toBe(false);
  });

  test("a no-op command adds no history entry", () => {
    const h = new History(base());
    h.apply(updateZoom("missing", { startUs: 1 }));
    expect(h.canUndo).toBe(false);
  });

  test("undo and redo on empty stacks do nothing", () => {
    const h = new History(base());
    const p = h.current;
    h.undo();
    h.redo();
    expect(h.current).toBe(p);
  });

  test("keeps at most 200 steps", () => {
    const h = new History(base());
    for (let i = 0; i < 250; i++) h.apply(setCursorHidden(i % 2 === 0));
    let n = 0;
    while (h.canUndo) {
      h.undo();
      n++;
    }
    expect(n).toBe(200);
  });

  test("subscribers are notified on apply, undo and redo, and can unsubscribe", () => {
    const h = new History(base());
    const fn = vi.fn();
    const off = h.subscribe(fn);
    h.apply(addZoom(zoom("a")));
    h.undo();
    h.redo();
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    h.undo();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("commands", () => {
  test("zoom commands add, update and remove", () => {
    let p = addZoom(zoom("a"))(base());
    expect(p.edits.zooms).toHaveLength(1);
    p = updateZoom("a", { endUs: 4_000_000 })(p);
    expect(p.edits.zooms[0]!.endUs).toBe(4_000_000);
    p = removeZoom("a")(p);
    expect(p.edits.zooms).toEqual([]);
  });

  test("cut commands add, update and remove", () => {
    let p = addCut(cut("c"))(base());
    p = updateCut("c", { startUs: 4_000_000 })(p);
    expect(p.edits.cuts[0]!.startUs).toBe(4_000_000);
    p = removeCut("c")(p);
    expect(p.edits.cuts).toEqual([]);
  });

  test("replaceAutoZooms keeps live and manual zooms and swaps auto ones", () => {
    let p = base();
    p = addZoom(zoom("live", "live"))(p);
    p = addZoom(zoom("man", "manual"))(p);
    p = addZoom(zoom("old-auto", "auto"))(p);
    p = replaceAutoZooms([{ ...zoom("new-auto", "auto"), startUs: 6_000_000, endUs: 8_000_000 }, zoom("on-top", "auto")])(p);
    // "on-top" overlaps the live and manual zooms, so it is skipped.
    expect(p.edits.zooms.map((z) => z.id).sort()).toEqual(["live", "man", "new-auto"]);
  });

  test("commands never mutate their input", () => {
    const p = deepFreeze(base());
    expect(() => {
      addZoom(zoom("a"))(p);
      addCut(cut("c"))(p);
      setCursorHidden(true)(p);
      replaceAutoZooms([zoom("x", "auto")])(p);
    }).not.toThrow();
  });

  test("unknown project fields survive every command", () => {
    let p = base();
    for (const cmd of [addZoom(zoom("a")), addCut(cut("c")), setCursorHidden(true), removeZoom("a"), removeCut("c")]) {
      p = cmd(p);
      expect((p as any).futureThing).toEqual({ keep: true });
    }
  });
});

describe("updateCamera", () => {
  test("fills in the defaults, keeps unknown fields, and is a no-op when nothing changes", () => {
    const p = parseProject({
      version: 1, id: "p", name: "n", createdAt: "2026-11-18T00:00:00Z", durationUs: 1_000_000,
      source: { width: 1920, height: 1080, fps: 60 },
      tracks: { screen: { file: "screen.mp4", offsetUs: 0 }, camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } },
      output: { width: 1920, height: 1080, fps: 60 },
    });
    expect(updateCamera({ mirror: true })(p)).toBe(p);
    const q = updateCamera({ pip: { corner: "topLeft" } })(p);
    expect(q.edits.camera).toEqual({ ...DEFAULT_CAMERA_EDITS, pip: { ...DEFAULT_CAMERA_EDITS.pip, corner: "topLeft" } });
    const withExtra = { ...q, edits: { ...q.edits, camera: { ...q.edits.camera!, later: 1 } } };
    expect((updateCamera({ visible: false })(withExtra).edits.camera as Record<string, unknown>).later).toBe(1);
  });
});
