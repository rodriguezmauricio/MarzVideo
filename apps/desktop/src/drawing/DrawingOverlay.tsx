// The selected drawing stroke on the preview (DESIGN-SYSTEM.md "Drawing on the preview"): its box as a
// 2px dashed accent rectangle with the zoom area's four corner handles. Drag inside to move, a corner to
// resize (the opposite corner stays; text keeps its aspect). One undo step on release. While dragging,
// the preview draws the stroke where it is going (`useStrokeDraft`).
import { useMemo, useRef } from "react";
import { create } from "zustand";
import type { Point, Stroke } from "@marz/format";
import type { StrokeMap } from "@marz/compositor";
import { movePoints, scalePoints, strokeBounds, updateStroke } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { measureStrokeText } from "./drawingFont";

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
/** Smallest box side while resizing, in source pixels. */
const MIN_SIDE = 8;

/** The stroke being dragged on the preview (drawn instead of the stored one), or null. */
export const useStrokeDraft = create<{ draft: Stroke | null }>(() => ({ draft: null }));

type Drag = { mode: "move" | Corner; x0: number; y0: number; orig: Stroke; box: { x: number; y: number; w: number; h: number } };

export function DrawingOverlay({ stroke, map, out }: { stroke: Stroke; map: StrokeMap; out: { width: number; height: number } }) {
  const apply = useEditorStore((s) => s.apply);
  const draft = useStrokeDraft((s) => s.draft);
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const measure = useMemo(() => measureStrokeText(), []);
  const shown = draft && draft.id === stroke.id ? draft : stroke;

  const { sx, sy, sw, sh } = map.srcRect;
  const { dx, dy, dw, dh } = map.dstRect;
  const kx = dw / sw;
  const ky = dh / sh;
  const b = strokeBounds(shown, measure);
  // Output pixels, then a share of the frame for CSS.
  const ox = dx + (b.x - sx) * kx;
  const oy = dy + (b.y - sy) * ky;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  /** Pointer position in source pixels. */
  const src = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const outX = ((e.clientX - r.left) / r.width) * out.width;
    const outY = ((e.clientY - r.top) / r.height) * out.height;
    return { x: sx + (outX - dx) / kx, y: sy + (outY - dy) / ky };
  };

  const start = (e: React.PointerEvent, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // No text selection or native drag: either cancels the pointer mid drag.
    e.preventDefault();
    boxRef.current!.setPointerCapture(e.pointerId);
    const p = src(e);
    drag.current = { mode, x0: p.x, y0: p.y, orig: stroke, box: strokeBounds(stroke, measure) };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = src(e);
    const o = d.orig;
    if (d.mode === "move") {
      useStrokeDraft.setState({ draft: { ...o, points: movePoints(o.points, p.x - d.x0, p.y - d.y0) } });
      return;
    }
    const bx = d.box;
    const ax = d.mode.includes("w") ? bx.x + bx.w : bx.x;
    const ay = d.mode.includes("n") ? bx.y + bx.h : bx.y;
    const wantW = Math.max(MIN_SIDE, d.mode.includes("w") ? ax - p.x : p.x - ax);
    const wantH = Math.max(MIN_SIDE, d.mode.includes("n") ? ay - p.y : p.y - ay);
    if (o.tool === "text") {
      const s = Math.max(wantH / bx.h, 0.05);
      const anchor: Point = [ax, ay];
      const pts = scalePoints(o.points, anchor[0], anchor[1], s, s);
      useStrokeDraft.setState({ draft: { ...o, width: Math.max(0.5, o.width * s), points: pts } });
      return;
    }
    const sxs = bx.w > 0 ? wantW / bx.w : 1;
    const sys = bx.h > 0 ? wantH / bx.h : 1;
    useStrokeDraft.setState({ draft: { ...o, points: scalePoints(o.points, ax, ay, sxs, sys) } });
  };

  const end = () => {
    const d = drag.current;
    drag.current = null;
    const final = useStrokeDraft.getState().draft;
    useStrokeDraft.setState({ draft: null });
    if (!d || !final || final.id !== d.orig.id) return;
    const round = (pts: Point[]): Point[] => pts.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]);
    apply(updateStroke(d.orig.id, { points: round(final.points), ...(final.width !== d.orig.width ? { width: Math.round(final.width * 10) / 10 } : {}) }));
  };

  return (
    <div ref={ref} data-testid="drawing-overlay" className="do">
      <div
        ref={boxRef}
        data-testid="drawing-box"
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        className="do-box"
        onPointerDown={(e) => start(e, "move")}
        style={{ left: pct(ox, out.width), top: pct(oy, out.height), width: pct(b.w * kx, out.width), height: pct(b.h * ky, out.height) }}
      >
        {CORNERS.map((c) => (
          <div key={c} data-testid={`drawing-handle-${c}`} onPointerDown={(e) => start(e, c)} className={`zo-hd ${c}`} />
        ))}
      </div>
    </div>
  );
}
