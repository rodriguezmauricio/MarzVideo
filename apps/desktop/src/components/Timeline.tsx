import { useEffect, useRef, useState } from "react";
import { updateCut, updateZoom } from "@marz/timeline";
import { MIN_US } from "../state/actions";
import { useEditorStore, type Selection } from "../state/editorStore";
import { handleWidthPx, MAX_TIMELINE_ZOOM, pxToUs, snapUs, timelineWidthPx, usToPx } from "./timelineMath";

type Kind = "zoom" | "cut";
type Mode = "move" | "start" | "end";
type Range = { startUs: number; endUs: number };
type Drag = { kind: Kind; id: string; mode: Mode; startX: number; orig: Range };

const SNAP_PX = 8;
const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const ORIGIN_CLASS = {
  live: "bg-emerald-500/70 border-emerald-300",
  auto: "bg-violet-500/70 border-violet-300",
  manual: "bg-sky-500/70 border-sky-300",
} as const;
const HATCH = "repeating-linear-gradient(45deg, rgba(239,68,68,.55) 0 6px, rgba(239,68,68,.25) 6px 12px)";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function Timeline() {
  const project = useEditorStore((s) => s.project)!;
  const playheadUs = useEditorStore((s) => s.playheadUs);
  const selection = useEditorStore((s) => s.selection);
  const seek = useEditorStore((s) => s.seek);
  const select = useEditorStore((s) => s.select);
  const apply = useEditorStore((s) => s.apply);

  const trackRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(800);
  const [zoomFactor, setZoomFactor] = useState(1);
  const playing = useEditorStore((s) => s.playing);
  type Draft = Range & { kind: Kind; id: string };
  const [draft, setDraftState] = useState<Draft | null>(null);
  // Latest draft in a ref too: pointerup can arrive before React re-renders after the last pointermove.
  const draftRef = useRef<Draft | null>(null);
  const setDraft = (d: Draft | null) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const drag = useRef<Drag | null>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientWidth));
    ro.observe(el);
    setViewport(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const D = project.durationUs;
  const width = timelineWidthPx(viewport, zoomFactor);
  const pps = width / (D / 1e6);
  const x = (us: number) => usToPx(us, pps);

  // While playing, keep the playhead in view when the timeline is zoomed in.
  useEffect(() => {
    const el = viewportRef.current;
    if (!playing || !el) return;
    const px = usToPx(playheadUs, pps);
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 20) el.scrollLeft = px - el.clientWidth / 3;
  }, [playheadUs, playing, pps]);

  // Ctrl+wheel zooms the timeline. Native listener: React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoomFactor((z) => Math.min(MAX_TIMELINE_ZOOM, Math.max(1, z * (e.deltaY < 0 ? 1.25 : 1 / 1.25))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f: number) => setZoomFactor((z) => Math.min(MAX_TIMELINE_ZOOM, Math.max(1, z * f)));
  const rangeOf = (kind: Kind, id: string, r: Range): Range =>
    draft && draft.kind === kind && draft.id === id ? draft : r;

  const seekFromEvent = (clientX: number) => {
    const left = trackRef.current!.getBoundingClientRect().left;
    seek(clamp(pxToUs(clientX - left, pps), 0, D));
  };

  const snapTargets = (skip: { kind: Kind; id: string }) => {
    const t = [0, D, playheadUs];
    for (const z of project.edits.zooms) if (!(skip.kind === "zoom" && skip.id === z.id)) t.push(z.startUs, z.endUs);
    for (const c of project.edits.cuts) if (!(skip.kind === "cut" && skip.id === c.id)) t.push(c.startUs, c.endUs);
    return t;
  };

  const onBlockDown = (e: React.PointerEvent, kind: Kind, id: string, mode: Mode, orig: Range) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    select({ kind, id } as Selection);
    drag.current = { kind, id, mode, startX: e.clientX, orig };
  };

  const onBlockMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dUs = pxToUs(e.clientX - d.startX, pps);
    const targets = snapTargets(d);
    const thr = pxToUs(SNAP_PX, pps);
    let s = d.orig.startUs;
    let en = d.orig.endUs;
    if (d.mode === "move") {
      const len = en - s;
      s = clamp(d.orig.startUs + dUs, 0, D - len);
      const snappedStart = snapUs(s, targets, thr);
      const snappedEnd = snapUs(s + len, targets, thr);
      s = snappedStart !== s ? snappedStart : snappedEnd !== s + len ? snappedEnd - len : s;
      s = clamp(s, 0, D - len);
      en = s + len;
    } else if (d.mode === "start") {
      s = clamp(snapUs(d.orig.startUs + dUs, targets, thr), 0, d.orig.endUs - MIN_US);
    } else {
      en = clamp(snapUs(d.orig.endUs + dUs, targets, thr), d.orig.startUs + MIN_US, D);
    }
    setDraft({ kind: d.kind, id: d.id, startUs: s, endUs: en });
  };

  const onBlockUp = () => {
    const d = drag.current;
    drag.current = null;
    const final = draftRef.current;
    setDraft(null);
    if (!d || !final || (final.startUs === d.orig.startUs && final.endUs === d.orig.endUs)) return;
    const patch = { startUs: final.startUs, endUs: final.endUs };
    apply(d.kind === "zoom" ? updateZoom(d.id, patch) : updateCut(d.id, patch));
  };

  const stepS = TICK_STEPS_S.find((s) => s * pps >= 70) ?? TICK_STEPS_S[TICK_STEPS_S.length - 1]!;
  const ticks: number[] = [];
  for (let s = 0; s <= D / 1e6; s += stepS) ticks.push(s);

  // A plain render helper, not a component: a component defined here would remount on every render and drop the drag.
  const handle = (kind: Kind, id: string, mode: Mode, orig: Range, blockPx: number) => (
    <div
      key={mode}
      data-testid={`handle-${kind}-${id}-${mode}`}
      onPointerDown={(e) => onBlockDown(e, kind, id, mode, orig)}
      onPointerMove={onBlockMove}
      onPointerUp={onBlockUp}
      className={`absolute top-0 h-full cursor-ew-resize ${mode === "start" ? "left-0" : "right-0"}`}
      style={{ width: handleWidthPx(blockPx) }}
    />
  );

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-4 pb-3 pt-2 select-none">
      <div className="mb-1 flex items-center justify-end gap-1 text-xs text-zinc-400">
        <span>Timeline zoom</span>
        <button type="button" title="Zoom timeline out (Ctrl+wheel)" aria-label="Zoom timeline out"
          onClick={() => zoomBy(1 / 1.5)} className="h-6 w-6 rounded bg-zinc-800 hover:bg-zinc-700">-</button>
        <button type="button" title="Zoom timeline in (Ctrl+wheel)" aria-label="Zoom timeline in"
          onClick={() => zoomBy(1.5)} className="h-6 w-6 rounded bg-zinc-800 hover:bg-zinc-700">+</button>
        <button type="button" title="Fit the whole recording" aria-label="Fit timeline"
          onClick={() => setZoomFactor(1)} className="h-6 rounded bg-zinc-800 px-2 hover:bg-zinc-700">Fit</button>
      </div>
      <div ref={viewportRef} className="overflow-x-auto">
      <div
        ref={trackRef}
        className="relative"
        style={{ width }}
        onPointerDown={(e) => {
          select(null);
          scrubbing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => scrubbing.current && seekFromEvent(e.clientX)}
        onPointerUp={() => (scrubbing.current = false)}
      >
        <div className="relative h-6 overflow-hidden border-b border-zinc-800 text-[10px] text-zinc-500">
          {ticks.map((s) => (
            <div key={s} className="absolute top-0 h-full border-l border-zinc-700 pl-1" style={{ left: x(s * 1e6) }}>
              {s}s
            </div>
          ))}
        </div>

        <div className="relative mt-2 h-9 rounded bg-zinc-900/60" title="Zooms">
          {project.edits.zooms.map((z) => {
            const r = rangeOf("zoom", z.id, z);
            const sel = selection?.kind === "zoom" && selection.id === z.id;
            return (
              <div
                key={z.id}
                data-testid={`zoom-${z.id}`}
                onPointerDown={(e) => onBlockDown(e, "zoom", z.id, "move", z)}
                onPointerMove={onBlockMove}
                onPointerUp={onBlockUp}
                className={`absolute top-1 h-7 cursor-grab rounded border text-[10px] leading-7 text-white ${ORIGIN_CLASS[z.origin]} ${sel ? "ring-2 ring-white" : ""}`}
                style={{ left: x(r.startUs), width: Math.max(4, x(r.endUs - r.startUs)) }}
              >
                <span className="pointer-events-none px-2">Zoom</span>
                {handle("zoom", z.id, "start", z, x(r.endUs - r.startUs))}
                {handle("zoom", z.id, "end", z, x(r.endUs - r.startUs))}
              </div>
            );
          })}
        </div>

        <div className="relative mt-1 h-9 rounded bg-zinc-900/60" title="Cuts">
          {project.edits.cuts.map((c) => {
            const r = rangeOf("cut", c.id, c);
            const sel = selection?.kind === "cut" && selection.id === c.id;
            return (
              <div
                key={c.id}
                data-testid={`cut-${c.id}`}
                onPointerDown={(e) => onBlockDown(e, "cut", c.id, "move", c)}
                onPointerMove={onBlockMove}
                onPointerUp={onBlockUp}
                className={`absolute top-1 h-7 cursor-grab rounded border border-red-300 text-[10px] leading-7 text-white ${sel ? "ring-2 ring-white" : ""}`}
                style={{ left: x(r.startUs), width: Math.max(4, x(r.endUs - r.startUs)), background: HATCH }}
              >
                <span className="pointer-events-none px-2">Cut</span>
                {handle("cut", c.id, "start", c, x(r.endUs - r.startUs))}
                {handle("cut", c.id, "end", c, x(r.endUs - r.startUs))}
              </div>
            );
          })}
        </div>

        <div
          data-testid="playhead"
          className="pointer-events-none absolute top-0 h-full w-px bg-white"
          style={{ left: x(playheadUs) }}
        >
          <div className="-ml-1 h-2 w-2 rounded-full bg-white" />
        </div>
      </div>
      </div>
    </div>
  );
}
