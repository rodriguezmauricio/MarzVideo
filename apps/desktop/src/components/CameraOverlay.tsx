// The selected camera bubble on the preview (DESIGN-SYSTEM.md "Camera on the preview"): its box as the
// drawing box (2px dashed accent, the zoom area's four corner handles). Drag inside to move it anywhere,
// a corner to resize (aspect kept, the opposite corner stays). Let go near a corner and it snaps there.
// One undo step on release. While dragging, the preview draws the bubble where it is going.
import { useRef } from "react";
import { create } from "zustand";
import { cameraEdits, type Pip } from "@marz/format";
import { dropPip, pipAtBox, resizeBubble, type Box } from "@marz/compositor";
import { placeCamera } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/** The pip being dragged on the preview (drawn instead of the stored one), or null. */
export const useCameraDraft = create<{ pip: Pip | null }>(() => ({ pip: null }));

type Size = { width: number; height: number };
type Drag = { mode: "move" | Corner; x0: number; y0: number; box: Box; last: Box };

export function CameraOverlay({ box, out, cam }: { box: Box; out: Size; cam: Size }) {
  const apply = useEditorStore((s) => s.apply);
  const project = useEditorStore((s) => s.project)!;
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pip = cameraEdits(project).pip;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  /** Pointer position in output pixels. */
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * out.width, y: ((e.clientY - r.top) / r.height) * out.height };
  };

  const start = (e: React.PointerEvent, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // No text selection or native drag: either cancels the pointer mid drag.
    e.preventDefault();
    boxRef.current!.setPointerCapture(e.pointerId);
    const p = at(e);
    drag.current = { mode, x0: p.x, y0: p.y, box, last: box };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    const b = d.box;
    const next =
      d.mode === "move"
        ? {
            ...b,
            x: Math.min(Math.max(0, b.x + p.x - d.x0), out.width - b.w),
            y: Math.min(Math.max(0, b.y + p.y - d.y0), out.height - b.h),
          }
        : resizeBubble(b, d.mode, p, out);
    d.last = next;
    useCameraDraft.setState({ pip: pipAtBox(pip, next, out) });
  };

  const end = () => {
    const d = drag.current;
    drag.current = null;
    useCameraDraft.setState({ pip: null });
    if (!d || (d.last.x === d.box.x && d.last.y === d.box.y && d.last.w === d.box.w)) return;
    apply(placeCamera(dropPip(pip, d.last, out, cam)));
  };

  const draft = useCameraDraft((s) => s.pip);
  // While dragging, the box follows the draft (the same box the compositor draws).
  const shown = draft && drag.current ? drag.current.last : box;

  return (
    <div ref={ref} data-testid="camera-overlay" className="do">
      <div
        ref={boxRef}
        data-testid="camera-box"
        className="do-box"
        onPointerDown={(e) => start(e, "move")}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        style={{ left: pct(shown.x, out.width), top: pct(shown.y, out.height), width: pct(shown.w, out.width), height: pct(shown.h, out.height) }}
      >
        {CORNERS.map((c) => (
          <div key={c} data-testid={`camera-handle-${c}`} onPointerDown={(e) => start(e, c)} className={`zo-hd ${c}`} />
        ))}
      </div>
    </div>
  );
}
