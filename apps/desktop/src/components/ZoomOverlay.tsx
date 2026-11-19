import { useRef, useState } from "react";
import type { Rect, Zoom } from "@marz/format";
import { clampRect, MIN_RECT_SIZE, updateZoom } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";

type Corner = "nw" | "ne" | "sw" | "se";
type Drag = { mode: "move" | Corner; nx0: number; ny0: number; orig: Rect };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/** Draggable zoom area drawn over the full (unzoomed) frame. The rect always keeps the output aspect ratio. */
export function ZoomOverlay({ zoom }: { zoom: Zoom }) {
  const project = useEditorStore((s) => s.project)!;
  const apply = useEditorStore((s) => s.apply);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraftState] = useState<Rect | null>(null);
  // The latest draft lives in a ref too: pointerup can arrive before React re-renders after the last pointermove.
  const draftRef = useRef<Rect | null>(null);
  const setDraft = (r: Rect | null) => {
    draftRef.current = r;
    setDraftState(r);
  };

  const aspect = project.output.width / project.output.height;
  const k = project.source.width / (aspect * project.source.height); // rect.h = rect.w * k
  const rect = draft ?? clampRect(zoom.rect);

  const norm = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { nx: (e.clientX - b.left) / b.width, ny: (e.clientY - b.top) / b.height };
  };

  const start = (e: React.PointerEvent, mode: Drag["mode"]) => {
    e.stopPropagation();
    // No text selection or native drag: either cancels the pointer mid drag.
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    const { nx, ny } = norm(e);
    drag.current = { mode, nx0: nx, ny0: ny, orig: rect };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { nx, ny } = norm(e);
    const o = d.orig;
    if (d.mode === "move") {
      setDraft({
        ...o,
        x: clamp(o.x + (nx - d.nx0), 0, 1 - o.w),
        y: clamp(o.y + (ny - d.ny0), 0, 1 - o.h),
      });
      return;
    }
    const ax = d.mode.includes("w") ? o.x + o.w : o.x;
    const ay = d.mode.includes("n") ? o.y + o.h : o.y;
    const right = nx >= ax;
    const down = ny >= ay;
    const availX = right ? 1 - ax : ax;
    const availY = (down ? 1 - ay : ay) / k;
    const w = clamp(Math.abs(nx - ax), MIN_RECT_SIZE, Math.max(MIN_RECT_SIZE, Math.min(availX, availY)));
    const h = w * k;
    setDraft({ x: right ? ax : ax - w, y: down ? ay : ay - h, w, h });
  };

  const end = () => {
    const final = draftRef.current;
    drag.current = null;
    setDraft(null);
    const r = zoom.rect;
    const same = final && final.x === r.x && final.y === r.y && final.w === r.w && final.h === r.h;
    if (final && !same) apply(updateZoom(zoom.id, { rect: final }));
  };

  return (
    <div ref={ref} data-testid="zoom-overlay" className="zo" onPointerMove={onMove} onPointerUp={end}>
      <div
        data-testid="zoom-rect"
        onPointerDown={(e) => start(e, "move")}
        className="zo-rect"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
        }}
      >
        {CORNERS.map((c) => (
          <div key={c} data-testid={`handle-${c}`} onPointerDown={(e) => start(e, c)} className={`zo-hd ${c}`} />
        ))}
      </div>
    </div>
  );
}
