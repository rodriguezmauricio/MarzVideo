// Draw mode while recording (DESIGN-SYSTEM.md "Recorder: draw mode"): a canvas over the whole monitor
// and the tool strip at the top centre. This is the recorder overlay window, which is excluded from
// every capture, so nothing drawn here is in screen.mp4. Each finished stroke goes to the engine
// (`drawOp`), which logs it in events.jsonl on the recording clock; the editor turns those lines into
// strokes. Strokes are kept in physical pixels from the monitor's top-left, the engine's unit.
import { useEffect, useRef, useState } from "react";
import { drawStrokes, type StrokeColors } from "@marz/compositor";
import { strokeWidths, type Point, type Stroke, type StrokeColor, type StrokeTool } from "@marz/format";
import { strokeAtPoint } from "@marz/timeline";
import { Icon, type IconName } from "../components/Icon";
import { strokeFamily } from "../drawing/drawingFont";
import { recorderApi } from "./recorderApi";

type Tool = StrokeTool | "eraser";
const TOOLS: Array<[Tool, string, IconName, string]> = [
  ["pen", "Pen", "pen", "P"],
  ["highlighter", "Highlight", "highlight", "H"],
  ["arrow", "Arrow", "arrow", "A"],
  ["rect", "Box", "box", "B"],
  ["ellipse", "Oval", "oval", "O"],
  ["text", "Text", "text", "T"],
  ["eraser", "Erase", "erase", "E"],
];
const COLORS: Array<[StrokeColor, string]> = [
  ["accent", "Accent"],
  ["rec", "Red"],
  ["paper", "Paper"],
  ["ink", "Ink"],
];
/** Eraser and text hit tolerance, CSS pixels. */
const HIT_CSS = 6;
/** Pen points closer than this (physical pixels) to the last one are skipped. */
const MIN_STEP = 2;

// The picks stay for the recording session (module state, the overlay page lives as long as it).
let pick: { tool: Tool; color: StrokeColor } = { tool: "pen", color: "accent" };
let nextId = 1;

function tokenColors(): StrokeColors {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { accent: v("--accent"), rec: v("--rec"), paper: v("--paper"), ink: v("--ink") };
}

type Draft = { stroke: Stroke; downAt: number };

export function DrawLayer() {
  const api = recorderApi();
  const scale = api.monitor.scale || 1;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setToolState] = useState<Tool>(pick.tool);
  const [color, setColorState] = useState<StrokeColor>(pick.color);
  const strokes = useRef<Stroke[]>([]);
  const draft = useRef<Draft | null>(null);
  const erasing = useRef(false);
  const [text, setText] = useState<{ x: number; y: number; at: number } | null>(null);
  const [, redraw] = useState(0);
  const width = strokeWidths(api.monitor.height).medium;
  const colors = useRef<StrokeColors>(tokenColors());
  const family = strokeFamily();

  const setTool = (t: Tool) => {
    pick = { ...pick, tool: t };
    setToolState(t);
  };
  const setColor = (c: StrokeColor) => {
    pick = { ...pick, color: c };
    setColorState(c);
  };

  const paint = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const items = [...strokes.current, ...(draft.current ? [draft.current.stroke] : [])].map((stroke) => ({ stroke, alpha: 1 }));
    const map = { srcRect: { sx: 0, sy: 0, sw: c.width, sh: c.height }, dstRect: { dx: 0, dy: 0, dw: c.width, dh: c.height } };
    drawStrokes(ctx, items, map, colors.current, family);
  };

  // Canvas in physical pixels, so strokes are drawn exactly where the engine logs them.
  useEffect(() => {
    const fit = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = Math.round(window.innerWidth * scale);
      c.height = Math.round(window.innerHeight * scale);
      paint();
    };
    fit();
    window.addEventListener("resize", fit);
    void document.fonts.load(`700 48px ${family}`).then(paint, () => undefined);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const phys = (e: { clientX: number; clientY: number }): Point => [Math.round(e.clientX * scale * 10) / 10, Math.round(e.clientY * scale * 10) / 10];
  const base = (t: StrokeTool, p: Point): Stroke => ({
    id: `s${nextId++}`,
    startUs: 0,
    endUs: 1,
    tool: t,
    color: pick.color,
    width,
    points: [p],
    origin: "live",
  });

  const send = (s: Stroke, downAt: number) => {
    const stroke = { tool: s.tool, color: s.color, width: s.width, points: s.points, ...(s.text ? { text: s.text } : {}) };
    api.drawOp({ op: "add", id: s.id, agoUs: Math.max(0, Math.round((performance.now() - downAt) * 1000)), stroke });
  };

  const eraseAt = (p: Point) => {
    const hit = strokeAtPoint(strokes.current, p[0], p[1], HIT_CSS * scale, measure);
    if (!hit) return;
    strokes.current = strokes.current.filter((s) => s.id !== hit.id);
    api.drawOp({ op: "remove", id: hit.id });
    paint();
  };

  const measure = (t: string, size: number) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return t.length * size * 0.55;
    ctx.font = `700 ${size}px ${family}`;
    return ctx.measureText(t).width;
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    // A press outside the open text field places that text first, then draws as usual.
    if (text) commitText();
    const p = phys(e);
    if (tool === "eraser") {
      erasing.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      eraseAt(p);
      return;
    }
    if (tool === "text") {
      // Keep the press from moving the focus to the page, so the new field keeps it.
      e.preventDefault();
      setText({ x: e.clientX, y: e.clientY, at: performance.now() });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = base(tool, p);
    if (tool !== "pen" && tool !== "highlighter") s.points = [p, p];
    draft.current = { stroke: s, downAt: performance.now() };
    paint();
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = phys(e);
    if (erasing.current) return eraseAt(p);
    const d = draft.current;
    if (!d) return;
    const pts = d.stroke.points;
    if (d.stroke.tool === "pen" || d.stroke.tool === "highlighter") {
      const last = pts[pts.length - 1]!;
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_STEP) return;
      d.stroke = { ...d.stroke, points: [...pts, p] };
    } else {
      d.stroke = { ...d.stroke, points: [pts[0]!, p] };
    }
    paint();
  };

  const onUp = () => {
    erasing.current = false;
    const d = draft.current;
    draft.current = null;
    if (!d) return;
    const [a, b] = [d.stroke.points[0]!, d.stroke.points[d.stroke.points.length - 1]!];
    // A shape with no size is a slip, not a stroke.
    if (d.stroke.tool !== "pen" && d.stroke.tool !== "highlighter" && Math.hypot(b[0] - a[0], b[1] - a[1]) < 4 * scale) return paint();
    strokes.current = [...strokes.current, d.stroke];
    send(d.stroke, d.downAt);
    paint();
  };

  const textRef = useRef<HTMLInputElement>(null);
  const commitText = () => {
    const t = text;
    const v = textRef.current?.value.trim() ?? "";
    setText(null);
    if (!t || !v) return;
    const s = { ...base("text", [Math.round(t.x * scale), Math.round(t.y * scale)]), text: v };
    strokes.current = [...strokes.current, s];
    send(s, t.at);
    paint();
  };

  const clearAll = () => {
    if (strokes.current.length === 0) return;
    strokes.current = [];
    api.drawOp({ op: "clear" });
    paint();
    redraw((n) => n + 1);
  };

  // Tool keys (the overlay has the keyboard in draw mode). Esc leaves draw mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toUpperCase();
      const t = TOOLS.find(([, , , key]) => key === k);
      if (t) return setTool(t[0]);
      if (k === "X") return clearAll();
      const n = Number(e.key);
      if (n >= 1 && n <= COLORS.length) return setColor(COLORS[n - 1]![0]);
      if (e.key === "Escape") void api.toggleDraw(false).catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!text) return;
    textRef.current?.focus();
    const t = window.setTimeout(() => textRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [text]);

  const textSize = (width * 8) / scale;
  return (
    <div className="dr-layer" data-testid="draw-layer">
      <canvas ref={canvasRef} className="dr-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      {text && (
        <input
          ref={textRef}
          className={`dr-text dr-${color}`}
          style={{ left: text.x, top: text.y, fontSize: textSize, height: textSize * 1.15 }}
          aria-label="Text on screen"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText();
            if (e.key === "Escape") {
              e.stopPropagation();
              setText(null);
            }
          }}
        />
      )}
      <div className="ro-modes dr-tools" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map(([t, label, icon, key]) => (
          <button key={t} type="button" className={`ro-mode${tool === t ? " on" : ""}`} aria-pressed={tool === t} onClick={() => setTool(t)}>
            <Icon name={icon} size={16} />
            {label}
            <span className="hk">{key}</span>
          </button>
        ))}
        <button type="button" className="ro-mode" onClick={clearAll}>
          <Icon name="trash" size={16} />
          Clear
          <span className="hk">X</span>
        </button>
        <span className="ro-mode dr-colors" role="radiogroup" aria-label="Drawing colour">
          {COLORS.map(([c, name], i) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={`${name} ${i + 1}`}
              title={`${name} / ${i + 1}`}
              className={`dr-sw dr-sw-${c}${color === c ? " on" : ""}`}
              onClick={() => setColor(c)}
            />
          ))}
        </span>
        <button type="button" className="ro-mode" onClick={() => void api.toggleDraw(false).catch(() => undefined)}>
          <Icon name="check" size={16} />
          Done
          <span className="hk">Esc</span>
        </button>
      </div>
    </div>
  );
}
