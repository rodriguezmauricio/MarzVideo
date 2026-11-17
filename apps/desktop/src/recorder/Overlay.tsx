// The recorder overlay: covers the whole monitor (transparent window). Mode picker top centre,
// capture region with handles and size chip, zoom presets. DESIGN-SYSTEM.md section 6 "Recorder".
// Works in CSS pixels; the store keeps the region in physical pixels.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { recorderApi } from "./recorderApi";
import { addPreset, useRecorder, type Mode } from "./recorderStore";
import {
  dragRect,
  moveRect,
  OUTPUT_ASPECT,
  presetFromDrag,
  presetPx,
  resizeRect,
  toCss,
  toNorm,
  toPhysical,
  type Handle,
  type PxRect,
  type Pt,
} from "./regionMath";

const MODES: { mode: Mode | "window"; label: string; icon: IconName }[] = [
  { mode: "full", label: "Full screen", icon: "fullscreen" },
  { mode: "window", label: "Window", icon: "window" },
  { mode: "region", label: "Region", icon: "region" },
  { mode: "exact", label: "Exact size", icon: "exact" },
];
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
/** A press that moves less than this is a click, not a drag. */
const CLICK_PX = 4;

type Drag =
  | { kind: "region-new"; start: Pt }
  | { kind: "region-resize"; handle: Handle; start: PxRect }
  | { kind: "region-move"; from: Pt; start: PxRect }
  | { kind: "preset-new"; start: Pt }
  | { kind: "preset-move"; id: string; from: Pt; start: PxRect }
  | { kind: "preset-resize"; id: string; handle: Handle; start: PxRect };

function handlePos(r: PxRect, h: Handle): Pt {
  const x = h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : r.x + r.w / 2;
  const y = h.includes("n") ? r.y : h.includes("s") ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}

export function Overlay({ children }: { children?: ReactNode }) {
  const api = recorderApi();
  const s = useRecorder();
  const scale = s.monitor.scale;
  const screen = { width: s.monitor.width / scale, height: s.monitor.height / scale };
  const full = s.mode === "full";
  // The capture area in CSS pixels: the region, or the whole monitor in Full screen.
  const area: PxRect = full ? { x: 0, y: 0, w: screen.width, h: screen.height } : toCss(s.region, scale);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [live, setLive] = useState<{ area?: PxRect; preset?: { id: string; rect: PxRect }; draft?: PxRect } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const shown = live?.area ?? area;
  const at = (e: { clientX: number; clientY: number }): Pt => ({ x: e.clientX, y: e.clientY });

  const begin = (e: ReactPointerEvent, d: Drag) => {
    if (e.button !== 0 || renaming) return;
    e.stopPropagation();
    rootRef.current?.setPointerCapture(e.pointerId);
    setDrag(d);
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = at(e);
    const lock = s.locked ? OUTPUT_ASPECT : undefined;
    switch (drag.kind) {
      case "region-new":
        return setLive({ area: dragRect(drag.start, p, screen, lock) });
      case "region-resize":
        return setLive({ area: resizeRect(drag.start, drag.handle, p, screen, lock) });
      case "region-move":
        return setLive({ area: moveRect(drag.start, p.x - drag.from.x, p.y - drag.from.y, screen) });
      case "preset-new":
        return setLive({ draft: presetPx(presetFromDrag(drag.start, p, area), area) });
      case "preset-move": {
        const local = { width: area.w, height: area.h };
        const r = moveRect({ ...drag.start, x: drag.start.x - area.x, y: drag.start.y - area.y }, p.x - drag.from.x, p.y - drag.from.y, local);
        return setLive({ preset: { id: drag.id, rect: { ...r, x: r.x + area.x, y: r.y + area.y } } });
      }
      case "preset-resize": {
        const local = { width: area.w, height: area.h };
        const start = { ...drag.start, x: drag.start.x - area.x, y: drag.start.y - area.y };
        const r = resizeRect(start, drag.handle, { x: p.x - area.x, y: p.y - area.y }, local, OUTPUT_ASPECT);
        return setLive({ preset: { id: drag.id, rect: { ...r, x: r.x + area.x, y: r.y + area.y } } });
      }
    }
  };

  const onUp = (e: ReactPointerEvent) => {
    if (!drag) return;
    const d = drag;
    const l = live;
    setDrag(null);
    setLive(null);
    const p = at(e);
    const moved = (from: Pt) => Math.abs(p.x - from.x) >= CLICK_PX || Math.abs(p.y - from.y) >= CLICK_PX;
    if ((d.kind === "region-resize" || d.kind === "region-move" || d.kind === "region-new") && l?.area) {
      if (d.kind === "region-new" && !moved(d.start)) return;
      s.update({ region: toPhysical(l.area, scale) });
    } else if (d.kind === "preset-new") {
      if (!moved(d.start)) return s.select(null);
      const list = addPreset(s.presets, presetFromDrag(d.start, p, area));
      const added = list.find((x) => !s.presets.some((o) => o.id === x.id));
      s.update({ presets: list });
      s.select(added?.id ?? null);
    } else if ((d.kind === "preset-move" || d.kind === "preset-resize") && l?.preset) {
      const local = { ...l.preset.rect, x: l.preset.rect.x - area.x, y: l.preset.rect.y - area.y };
      const rect = toNorm(local, { width: area.w, height: area.h });
      s.update({ presets: s.presets.map((x) => (x.id === d.id ? { ...x, rect } : x)) });
    }
  };

  const remove = (id: string) => {
    s.update({ presets: s.presets.filter((p) => p.id !== id) });
    if (s.selected === id) s.select(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (e.key === "Escape") {
        e.preventDefault();
        void api.close();
      } else if (e.key === "Delete" && s.selected) {
        remove(s.selected);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyR") {
        e.preventDefault();
        api.requestRecord();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const setMode = (mode: Mode) => s.update({ mode });

  // The area outside the region, dimmed in four bands (none in Full screen).
  const dims = full
    ? []
    : [
        { left: 0, top: 0, width: screen.width, height: shown.y },
        { left: 0, top: shown.y + shown.h, width: screen.width, height: screen.height - shown.y - shown.h },
        { left: 0, top: shown.y, width: shown.x, height: shown.h },
        { left: shown.x + shown.w, top: shown.y, width: screen.width - shown.x - shown.w, height: shown.h },
      ];
  const phys = toPhysical(shown, scale);

  return (
    <div ref={rootRef} className="rec-ov" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {dims.map((st, i) => (
        <div
          key={i}
          className="ro-dim"
          style={st}
          onPointerDown={s.mode === "region" ? (e) => begin(e, { kind: "region-new", start: at(e) }) : undefined}
        />
      ))}
      <div
        className={`ro-area${full ? " full" : ""}`}
        style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }}
        onPointerDown={full ? undefined : (e) => begin(e, { kind: "region-move", from: at(e), start: area })}
      >
        <div className="ro-in" onPointerDown={(e) => begin(e, { kind: "preset-new", start: at(e) })} />
      </div>
      {s.mode === "region" &&
        HANDLES.map((h) => {
          const c = handlePos(shown, h);
          const corner = CORNERS.includes(h);
          return (
            <i
              key={h}
              className={`ro-h ${corner ? "corner" : h === "n" || h === "s" ? "hbar" : "vbar"} h-${h}`}
              style={{ left: c.x, top: c.y }}
              onPointerDown={(e) => begin(e, { kind: "region-resize", handle: h, start: area })}
            />
          );
        })}

      <SizeChip area={shown} phys={phys} />

      {s.presets.map((p) => {
        const r = live?.preset?.id === p.id ? live.preset.rect : presetPx(p.rect, area);
        const sel = s.selected === p.id;
        return (
          <div
            key={p.id}
            className={`ro-preset${sel ? " sel" : ""}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            onPointerDown={(e) => {
              s.select(p.id);
              begin(e, { kind: "preset-move", id: p.id, from: at(e), start: r });
            }}
          >
            <span className="ro-tag" onPointerDown={(e) => e.stopPropagation()}>
              <b>{p.id}</b>
              {renaming === p.id ? (
                <RenameField
                  name={p.name}
                  done={(name) => {
                    setRenaming(null);
                    if (name !== null && name.trim()) s.update({ presets: s.presets.map((x) => (x.id === p.id ? { ...x, name: name.trim() } : x)) });
                  }}
                />
              ) : (
                <button type="button" className="ro-name" onClick={() => setRenaming(p.id)}>
                  {p.name}
                </button>
              )}
              <span>Ctrl+{p.id}</span>
              <button type="button" className="ro-x" aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)}>
                <Icon name="close" size={12} />
              </button>
            </span>
            {sel &&
              CORNERS.map((h) => {
                const c = handlePos({ x: 0, y: 0, w: r.w, h: r.h }, h);
                return (
                  <i
                    key={h}
                    className="ro-ph"
                    style={{ left: c.x, top: c.y }}
                    onPointerDown={(e) => begin(e, { kind: "preset-resize", id: p.id, handle: h, start: r })}
                  />
                );
              })}
          </div>
        );
      })}
      {live?.draft && <div className="ro-preset draft" style={{ left: live.draft.x, top: live.draft.y, width: live.draft.w, height: live.draft.h }} />}

      <div className="ro-modes" role="radiogroup" aria-label="Capture mode">
        {MODES.map((m) =>
          m.mode === "window" ? (
            <span key={m.mode} className="ro-mode off" aria-disabled="true">
              <Icon name={m.icon} size={16} />
              {m.label}
              <span className="ro-later">Not in this version</span>
            </span>
          ) : (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={s.mode === m.mode}
              className={`ro-mode${s.mode === m.mode ? " on" : ""}`}
              onClick={() => setMode(m.mode as Mode)}
            >
              <Icon name={m.icon} size={16} />
              {m.label}
            </button>
          ),
        )}
        <button type="button" className="ro-mode ro-close" onClick={() => void api.close()}>
          <Icon name="close" size={16} />
          Close
          <span className="hk">Esc</span>
        </button>
      </div>
      {children}
    </div>
  );
}

function RenameField({ name, done }: { name: string; done: (name: string | null) => void }) {
  const [v, setV] = useState(name);
  return (
    <input
      className="ro-rename"
      autoFocus
      value={v}
      maxLength={40}
      size={Math.max(4, v.length)}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => done(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(v);
        else if (e.key === "Escape") done(null);
        e.stopPropagation();
      }}
    />
  );
}

/** Above the region's top-left: size and lock (Region), typed size (Exact size), or the monitor (Full screen). */
function SizeChip({ area, phys }: { area: PxRect; phys: PxRect }) {
  const s = useRecorder();
  if (s.mode === "full") {
    return (
      <div className="ro-chip" style={{ left: 24, top: 100 }}>
        Full screen, {s.monitor.width} x {s.monitor.height}
      </div>
    );
  }
  const pos = { left: area.x, top: Math.max(0, area.y - 30) };
  if (s.mode === "exact") {
    const apply = (w: number, h: number) => {
      const mw = s.monitor.width;
      const mh = s.monitor.height;
      const W = Math.min(Math.max(1, Math.round(w)), mw);
      const H = Math.min(Math.max(1, Math.round(h)), mh);
      s.update({ region: { x: Math.min(s.region.x, mw - W), y: Math.min(s.region.y, mh - H), w: W, h: H } });
    };
    return (
      <div className="ro-chip" style={pos}>
        <SizeInput label="Width" value={s.region.w} set={(w) => apply(w, s.region.h)} />x
        <SizeInput label="Height" value={s.region.h} set={(h) => apply(s.region.w, h)} />
      </div>
    );
  }
  return (
    <div className="ro-chip" style={pos}>
      <button
        type="button"
        className="ro-lock"
        aria-pressed={s.locked}
        aria-label={s.locked ? "Free the ratio" : "Lock 16:9"}
        onClick={() => s.update({ locked: !s.locked })}
      >
        <Icon name="lock" size={12} />
      </button>
      {phys.w} x {phys.h}, {s.locked ? "16:9 locked" : "free"}
    </div>
  );
}

function SizeInput({ label, value, set }: { label: string; value: number; set: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const apply = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) set(n);
    else setV(String(value));
  };
  return (
    <input
      className="ro-num"
      aria-label={label}
      inputMode="numeric"
      value={v}
      onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === "Enter") apply();
        e.stopPropagation();
      }}
    />
  );
}
