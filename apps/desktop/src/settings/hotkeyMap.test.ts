import { describe, expect, it } from "vitest";
import { ACTIONS, comboFromEvent, comboProblem, DEFAULT_BINDINGS, matchesCombo, rangeLabel, rebound } from "./hotkeyMap";

const ev = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe("hotkey map", () => {
  it("has the 19 recorder hotkeys with distinct valid defaults", () => {
    expect(ACTIONS).toHaveLength(19);
    for (const a of ACTIONS) expect(comboProblem(a.id, a.combo, DEFAULT_BINDINGS)).toBeNull();
  });

  it("reads a key press in Ctrl, Alt, Shift order", () => {
    expect(comboFromEvent(ev("KeyR", { shift: true, ctrl: true }))).toBe("Ctrl+Shift+R");
    expect(comboFromEvent(ev("KeyK", { alt: true, shift: true, ctrl: true }))).toBe("Ctrl+Alt+Shift+K");
    expect(comboFromEvent(ev("Digit3", { ctrl: true }))).toBe("Ctrl+3");
    expect(comboFromEvent(ev("F12", { alt: true }))).toBe("Alt+F12");
    expect(comboFromEvent(ev("ShiftLeft", { shift: true }))).toBeNull();
    expect(comboFromEvent(ev("Space", { ctrl: true }))).toBeNull();
    expect(matchesCombo(ev("KeyR", { ctrl: true, shift: true }), "Ctrl+Shift+R")).toBe(true);
    expect(matchesCombo(ev("KeyR", { ctrl: true }), "Ctrl+Shift+R")).toBe(false);
  });

  it("refuses bare keys, editor keys and clashes", () => {
    expect(comboProblem("draw", "Shift+D", DEFAULT_BINDINGS)).toBe("Needs Ctrl or Alt.");
    expect(comboProblem("draw", "D", DEFAULT_BINDINGS)).toBe("Needs Ctrl or Alt.");
    expect(comboProblem("draw", "Ctrl+Z", DEFAULT_BINDINGS)).toBe("Ctrl+Z is the editor's undo.");
    expect(comboProblem("draw", "Ctrl+E", DEFAULT_BINDINGS)).toBe("Ctrl+E opens the export panel.");
    expect(comboProblem("pause", "Ctrl+Shift+R", DEFAULT_BINDINGS)).toBe("Already used by Record and stop.");
    expect(comboProblem("recordStop", "Ctrl+Shift+R", DEFAULT_BINDINGS)).toBeNull();
    expect(comboProblem("recordStop", "Ctrl+Alt+R", DEFAULT_BINDINGS)).toBeNull();
  });

  it("stores only the rebound keys and labels ranges", () => {
    const all = { ...DEFAULT_BINDINGS, mute: "Ctrl+Alt+M" };
    expect(rebound(all)).toEqual({ mute: "Ctrl+Alt+M" });
    expect(rangeLabel(DEFAULT_BINDINGS, ["preset1", "preset2", "preset9"])).toBe("Ctrl+1 to Ctrl+9");
    expect(rangeLabel(DEFAULT_BINDINGS, ["zoomOut"])).toBe("Ctrl+0");
  });
});
