import { useRef, useState } from "react";
import { cameraScenes, transitionFor, type SwitchSpec } from "@marz/format";
import { pathControls, pathPoint, switchEnds, toPathCoords } from "@marz/compositor";
import { setTransition } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { layoutBefore } from "./SwitchBlock";
import "./camera-extras.css";

type Path = NonNullable<SwitchSpec["path"]>;
const STRAIGHT: Path = { c1: [1 / 3, 0], c2: [2 / 3, 0] };
const STEPS = 48;

/** Whether the path editor shows: a layout selected, paused, its layout before it differs. */
export function usePathEditing(): boolean {
  const project = useEditorStore((s) => s.project);
  const selection = useEditorStore((s) => s.selection);
  const playing = useEditorStore((s) => s.playing);
  if (!project || playing || selection?.kind !== "layout") return false;
  const scene = cameraScenes(project).find((s) => s.id === selection.id);
  return !!scene && layoutBefore(project, scene) !== scene.layout;
}

/** The switch path of the selected layout on the preview: start and end camera boxes, the curve, and two
 *  handles to bend it. One drag is one undo step (applied on release). */
export function PathOverlay() {
  const project = useEditorStore((s) => s.project)!;
  const selection = useEditorStore((s) => s.selection);
  const apply = useEditorStore((s) => s.apply);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<0 | 1 | null>(null);
  const [draft, setDraftState] = useState<Path | null>(null);
  const draftRef = useRef<Path | null>(null);
  const setDraft = (p: Path | null) => {
    draftRef.current = p;
    setDraftState(p);
  };

  const scene = cameraScenes(project).find((s) => s.id === selection?.id);
  if (!scene) return null;
  const from = layoutBefore(project, scene);
  const to = scene.layout;
  const out = project.output;
  const ends = switchEnds(project, from, to, out);
  if (!ends) return null;
  const { a, b } = ends;
  const saved = transitionFor(project, from, to).path;
  const path = draft ?? saved ?? STRAIGHT;
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  if (Math.hypot(cb.x - ca.x, cb.y - ca.y) < 1) return null; // start and end in the same place: no path to bend
  const [c1, c2] = pathControls(a, b, path);
  const pts = Array.from({ length: STEPS + 1 }, (_, i) => pathPoint(a, b, i / STEPS, path));
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  const toOut = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * out.width, y: ((e.clientY - r.top) / r.height) * out.height };
  };
  const start = (i: 0 | 1) => (e: React.PointerEvent) => {
    e.stopPropagation();
    ref.current!.setPointerCapture(e.pointerId);
    drag.current = i;
  };
  const move = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    const uv = toPathCoords(a, b, toOut(e));
    if (!uv) return;
    const clamp = (v: number) => Math.max(-4, Math.min(4, Math.round(v * 1000) / 1000));
    const c: [number, number] = [clamp(uv[0]), clamp(uv[1])];
    const cur = draftRef.current ?? saved ?? STRAIGHT;
    setDraft(drag.current === 0 ? { c1: c, c2: cur.c2 } : { c1: cur.c1, c2: c });
  };
  const end = () => {
    const final = draftRef.current;
    drag.current = null;
    setDraft(null);
    if (final) apply(setTransition(from, to, { path: final }));
  };

  const box = (r: typeof a) => (
    <rect className="po-box" x={r.x} y={r.y} width={Math.max(0, r.w)} height={Math.max(0, r.h)} vectorEffect="non-scaling-stroke" />
  );
  return (
    <div ref={ref} className="po" data-testid="path-overlay" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <svg viewBox={`0 0 ${out.width} ${out.height}`} preserveAspectRatio="none" aria-hidden="true">
        {box(a)}
        {box(b)}
        <line className="po-arm" x1={ca.x} y1={ca.y} x2={c1.x} y2={c1.y} vectorEffect="non-scaling-stroke" />
        <line className="po-arm" x1={cb.x} y1={cb.y} x2={c2.x} y2={c2.y} vectorEffect="non-scaling-stroke" />
        <polyline className="po-path" points={pts.map((p) => `${p.x},${p.y}`).join(" ")} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="po-hd" data-testid="path-handle-1" aria-label="Path control 1" style={{ left: pct(c1.x, out.width), top: pct(c1.y, out.height) }} onPointerDown={start(0)} />
      <div className="po-hd" data-testid="path-handle-2" aria-label="Path control 2" style={{ left: pct(c2.x, out.width), top: pct(c2.y, out.height) }} onPointerDown={start(1)} />
    </div>
  );
}
