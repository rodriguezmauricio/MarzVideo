import { useEffect, useRef, useState } from "react";
import { cameraScenes, cursorSections, drawingStrokes, keyComboLabel, keyItems, verticalEdits } from "@marz/format";
import { updateCursorSection, updateKeyItem, updateCut, updateHold, updateScene, updateStroke, updateZoom } from "@marz/timeline";
import { frameLabels } from "../vertical/VerticalPanels";
import { aimPathFor } from "../vertical/aimPath";
import { MIN_US } from "../state/actions";
import { useEditorStore, type Selection } from "../state/editorStore";
import { Icon } from "./Icon";
import { MicWave, ScreenThumbs } from "./Lanes";
import { count, mmss } from "./timecode";
import { handleWidthPx, MAX_TIMELINE_ZOOM, pxToUs, snapUs, timelineWidthPx, usToPx } from "./timelineMath";
import { cursorBlockLabel, cutCapLabel, LAYOUT_LABEL, STROKE_LABEL, zoomLabels } from "./zoomLabels";
import { useCaptionFacts } from "../captions/captionActions";
import { MAIN_TRACK, packRows, rowGeometry } from "./mainTrack";

/** Roughly how wide a 10px mono label is, to hide labels that would not fit (micro type). */
const labelPx = (text: string, ai: boolean) => text.length * 7 + (ai ? 26 : 0) + 8;

type Kind = "zoom" | "cut" | "layout" | "cursor" | "key" | "drawing" | "frame";
type Mode = "move" | "start" | "end";
type Range = { startUs: number; endUs: number };
type Drag = { kind: Kind; id: string; mode: Mode; startX: number; orig: Range };

const SNAP_PX = 8;
const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300];
/** Space after the end of the recording (room for the last ruler label) plus the 24px right margin. */
const TAIL_PX = 32;
const LATER_LANES = ["Camera", "System audio", "Layout", "Drawing", "Captions"];
const ROWS = {
  fit: { ruler: 28, screen: 52, mic: 44, zoom: 44, later: 22 },
  expanded: { ruler: 28, screen: 80, mic: 72, zoom: 56, later: 44 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `expanded`: the lanes view; otherwise the main track view (DESIGN-SYSTEM.md "Timeline", two views). */
export function Timeline({ expanded, onToggleLanes }: { expanded: boolean; onToggleLanes: () => void }) {
  const project = useEditorStore((s) => s.project)!;
  const storage = useEditorStore((s) => s.storage)!;
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
    const measure = () => setViewport(Math.max(100, el.clientWidth - TAIL_PX));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const D = project.durationUs;
  const scenes = cameraScenes(project);
  const vertical = useEditorStore((s) => s.verticalPreview);
  const holds = verticalEdits(project).holds;
  const events = useEditorStore((s) => s.events);
  const strokes = drawingStrokes(project);
  const curSecs = cursorSections(project);
  const keyBlocks = keyItems(project);
  // The Keys lane shows only in takes with logged shortcuts (an opt-in recording option).
  const laterLanes = keyBlocks.length > 0 ? [...LATER_LANES, "Keys"] : LATER_LANES;
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

  /** A click on a block outside the playhead moves the playhead into it, so the preview shows it. */
  const seekInto = (r: Range) => {
    const ph = useEditorStore.getState().playheadUs;
    if (ph < r.startUs || ph >= r.endUs) seek(r.startUs + Math.min(500_000, (r.endUs - r.startUs) / 2));
  };

  const snapTargets = (skip: { kind: Kind; id: string }) => {
    const t = [0, D, playheadUs];
    for (const z of project.edits.zooms) if (!(skip.kind === "zoom" && skip.id === z.id)) t.push(z.startUs, z.endUs);
    for (const c of project.edits.cuts) if (!(skip.kind === "cut" && skip.id === c.id)) t.push(c.startUs, c.endUs);
    for (const sc of scenes) if (!(skip.kind === "layout" && skip.id === sc.id)) t.push(sc.startUs, sc.endUs);
    if (vertical) for (const h of holds) if (!(skip.kind === "frame" && skip.id === h.id)) t.push(h.startUs, h.endUs);
    for (const st of strokes) if (!(skip.kind === "drawing" && skip.id === st.id)) t.push(st.startUs, st.endUs);
    for (const cs of curSecs) if (!(skip.kind === "cursor" && skip.id === cs.id)) t.push(cs.startUs, cs.endUs);
    for (const k of keyBlocks) if (!(skip.kind === "key" && skip.id === k.id)) t.push(k.startUs, k.endUs);
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
    apply(
      d.kind === "frame"
        ? updateHold(d.id, patch)
        : d.kind === "cursor"
          ? updateCursorSection(d.id, patch)
          : d.kind === "key"
          ? updateKeyItem(d.id, patch)
          : d.kind === "layout"
            ? updateScene(d.id, patch)
            : d.kind === "drawing"
              ? updateStroke(d.id, patch)
              : d.kind === "zoom"
                ? updateZoom(d.id, patch)
                : updateCut(d.id, patch),
    );
  };

  const stepS = TICK_STEPS_S.find((s) => s * pps >= 70) ?? TICK_STEPS_S[TICK_STEPS_S.length - 1]!;
  const ruler = [];
  for (let s = 0; s <= D / 1e6 + 1e-9; s += stepS) {
    ruler.push(<i key={`M${s}`} className="tick tick-major" style={{ left: x(s * 1e6) }} />);
    ruler.push(<span key={`L${s}`} className="tick-lbl" style={{ left: x(s * 1e6) + 4 }}>{mmss(s * 1e6)}</span>);
    const half = s + stepS / 2;
    if (half <= D / 1e6) ruler.push(<i key={`m${s}`} className="tick tick-minor" style={{ left: x(half * 1e6) }} />);
  }

  // A plain render helper, not a component: a component defined here would remount on every render and drop the drag.
  const handle = (kind: Kind, id: string, mode: Mode, orig: Range, blockPx: number) => (
    <div
      key={mode}
      data-testid={`handle-${kind}-${id}-${mode}`}
      onPointerDown={(e) => onBlockDown(e, kind, id, mode, orig)}
      onPointerMove={onBlockMove}
      onPointerUp={onBlockUp}
      className="grab"
      style={{ width: handleWidthPx(blockPx), [mode === "start" ? "left" : "right"]: 0 }}
    />
  );

  const rows = expanded ? ROWS.expanded : ROWS.fit;
  const labels = zoomLabels(project.edits.zooms);
  const mic = project.tracks.mic;
  const sys = project.tracks.system;
  const cam = project.tracks.camera;
  /** A Later lane that this recording fills: computer sound, or the camera. */
  const real = (name: string) =>
    (name === "System audio" && !!sys) || ((name === "Camera" || name === "Layout") && !!cam) || (name === "Captions" && hasWords) || (name === "Drawing" && strokes.length > 0) || (name === "Keys" && keyBlocks.length > 0);
  const nAuto = project.edits.zooms.filter((z) => z.origin === "auto").length;
  const nOwn = project.edits.zooms.length - nAuto;
  const nAi = project.edits.zooms.filter((z) => z.origin === "ai").length + project.edits.cuts.filter((c) => c.origin === "ai").length;
  const words = useEditorStore((s) => s.words);
  const hasWords = words.length > 0;
  const overrides = project.edits.captions?.overrides ?? {};
  const hiddenWords = new Set(project.edits.captions?.hidden ?? []);
  const capStarts = useCaptionFacts().starts;

  const scrub = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      select(null);
      scrubbing.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromEvent(e.clientX);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => scrubbing.current && seekFromEvent(e.clientX),
    onPointerUp: () => (scrubbing.current = false),
  };

  const cutEls = project.edits.cuts.map((c) => {
    const r = rangeOf("cut", c.id, c);
    const sel = selection?.kind === "cut" && selection.id === c.id;
    const left = x(r.startUs);
    const w = Math.max(4, x(r.endUs - r.startUs));
    return (
      <div key={c.id}>
        <div className={`cutband${sel ? " sel" : ""}`} style={{ left, width: w }} />
        <div
          data-testid={`cut-${c.id}`}
          onPointerDown={(e) => onBlockDown(e, "cut", c.id, "move", c)}
          onPointerMove={onBlockMove}
          onPointerUp={onBlockUp}
          className="cutcap"
          style={{ left, width: w }}
        >
          {w >= labelPx(cutCapLabel(c), c.origin === "ai") && (
            <span className="lbl-ai">
              {cutCapLabel(c)}
              {c.origin === "ai" && <b className="ai-tag">AI</b>}
            </span>
          )}
          {handle("cut", c.id, "start", c, w)}
          {handle("cut", c.id, "end", c, w)}
        </div>
      </div>
    );
  });

  // The Edits track (main track view): every editable block, stacked in rows where they overlap.
  type MainItem = { kind: Kind; id: string; range: Range; cls: string; label: string; ai?: boolean; color?: string; onDown?: () => void };
  const mainItems: MainItem[] = [
    ...project.edits.zooms.map((z): MainItem => ({ kind: "zoom", id: z.id, range: z, cls: z.origin === "auto" ? "blk-sug" : "blk-zoom", label: labels.get(z.id) ?? "Zoom", ai: z.origin === "ai" })),
    ...(cam ? scenes.map((sc): MainItem => ({ kind: "layout", id: sc.id, range: sc, cls: `blk-lay${sc.origin === "live" ? " live" : ""}`, label: LAYOUT_LABEL[sc.layout] })) : []),
    ...curSecs.map((cs): MainItem => ({ kind: "cursor", id: cs.id, range: cs, cls: "blk-cur", label: cursorBlockLabel(cs) })),
    ...keyBlocks.map((k): MainItem => ({ kind: "key", id: k.id, range: k, cls: `blk-key${k.hidden ? " hid" : ""}`, label: keyComboLabel(k), onDown: () => seekInto(k) })),
    ...strokes.map((st): MainItem => ({
      kind: "drawing", id: st.id, range: st, cls: "blk-draw", label: STROKE_LABEL[st.tool], color: st.color,
      // The playhead moves into the stroke so the preview shows it.
      onDown: () => {
        const ph = useEditorStore.getState().playheadUs;
        if (ph < st.startUs || ph >= st.endUs) seek(st.startUs + Math.min(500_000, (st.endUs - st.startUs) / 2));
      },
    })),
    ...(vertical ? holds.map((h): MainItem => ({ kind: "frame", id: h.id, range: h, cls: "blk-frame", label: frameLabels(holds).get(h.id) ?? "Frame" })) : []),
  ];
  const packed = packRows(mainItems.map((m) => ({ id: `${m.kind}:${m.id}`, startUs: m.range.startUs, endUs: m.range.endUs })));
  const mainBody = (
    <div className="tl-body" data-testid="main-track-view">
      <div className="tl-gutter">
        <div className="lb" style={{ height: rows.ruler }} />
        <div className="lb" style={{ height: rows.screen }}>Screen</div>
        <div className="lb" style={{ height: MAIN_TRACK }}>Edits</div>
        <div className="lb" style={{ height: rows.mic }}>Mic</div>
      </div>
      <div ref={viewportRef} className="tl-scroll">
        <div ref={trackRef} className="tl-tracks" style={{ width: width + TAIL_PX }} {...scrub}>
          <div className="tk" style={{ height: rows.ruler }}>{ruler}</div>
          <div className="tk" style={{ height: rows.screen }}>
            <ScreenThumbs url={storage.fileUrl(project.tracks.screen.file)} durationUs={D}
              widthPx={x(D)} pps={pps} rowH={rows.screen} />
          </div>
          <div className="tk" style={{ height: MAIN_TRACK }} data-testid="edits-track">
            {mainItems.map((m) => {
              const r = rangeOf(m.kind, m.id, m.range);
              const sel = selection?.kind === m.kind && selection.id === m.id;
              const w = Math.max(4, x(r.endUs - r.startUs));
              const g = rowGeometry(packed.row.get(`${m.kind}:${m.id}`) ?? 0, packed.rows);
              const draw = m.kind === "drawing";
              return (
                <div
                  key={`${m.kind}:${m.id}`}
                  data-testid={`${m.kind}-${m.id}`}
                  onPointerDown={(e) => {
                    onBlockDown(e, m.kind, m.id, "move", m.range);
                    m.onDown?.();
                  }}
                  onPointerMove={onBlockMove}
                  onPointerUp={onBlockUp}
                  className={`blk ${m.cls}${sel ? " sel" : ""}`}
                  style={{ left: x(r.startUs), width: w, top: g.top, height: g.height, zIndex: sel ? 3 : 2 }}
                  title={m.label}
                >
                  {draw ? <i className={`dot sw-${m.color}`} /> : <i className="g l" />}
                  {w >= labelPx(m.label, !!m.ai) + (draw ? 24 : 16) && (
                    <span className="lbl-ai">
                      {m.label}
                      {m.ai && <b className="ai-tag">AI</b>}
                    </span>
                  )}
                  <i className="g r" />
                  {handle(m.kind, m.id, "start", m.range, w)}
                  {handle(m.kind, m.id, "end", m.range, w)}
                </div>
              );
            })}
          </div>
          <div className="tk" style={{ height: rows.mic }}>
            {mic && <MicWave url={storage.fileUrl(mic.file)} offsetUs={mic.offsetUs} widthPx={x(D)} pps={pps} rowH={rows.mic} />}
          </div>
          {cutEls}
          <div data-testid="playhead" className="ph" style={{ left: x(playheadUs) }}>
            <i />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <section className="tl" aria-label="Timeline">
      <div className="tl-head">
        <b>Timeline</b>
        <span className="tl-ctl">
          <span className="bx">Zoom</span>
          <button type="button" className="bx" aria-label="Zoom timeline out" data-tip="Zoom out / Ctrl+wheel"
            onClick={() => zoomBy(1 / 1.5)}>-</button>
          <button type="button" className="bx" aria-label="Zoom timeline in" data-tip="Zoom in / Ctrl+wheel"
            onClick={() => zoomBy(1.5)}>+</button>
          <button type="button" className="bx" aria-label="Fit timeline" data-tip="Fit the whole recording"
            onClick={() => setZoomFactor(1)}>Fit</button>
          <button type="button" className="bx bx-lanes" aria-pressed={expanded} onClick={onToggleLanes}
            data-tip={expanded ? "Main track / G" : "Show lanes / G"}>
            <Icon name="layers" size={13} />
            {expanded ? "Main track" : "Show lanes"}
            <span className="bx-key">G</span>
          </button>
        </span>
      </div>
      {!expanded ? mainBody : (
      <div className={vertical ? "tl-body vert" : "tl-body"}>
        <div className="tl-gutter">
          <div className="lb" style={{ height: rows.ruler }} />
          <div className="lb" style={{ height: rows.screen }}>Screen</div>
          <div className="lb" style={{ height: rows.mic }}>
            Mic
            {expanded && mic && (
              <span className="lb-vol" aria-label="Mic volume">
                <span><i style={{ width: `${Math.round(Math.min(1, Math.max(0, mic.volume)) * 100)}%` }} /></span>
                {Math.round(mic.volume * 100)}%
              </span>
            )}
          </div>
          <div className="lb" style={{ height: rows.zoom }}>Zoom</div>
          {vertical && <div className="lb" style={{ height: rows.later }}>Vertical</div>}
          <div className="lb" style={{ height: rows.later }}>Cursor</div>
          {laterLanes.map((name) =>
            real(name) ? (
              <div key={name} className="lb" style={{ height: rows.later }}>{name}</div>
            ) : (
              <div key={name} className="lb later" style={{ height: rows.later }}>{name}</div>
            ),
          )}
        </div>
        <div ref={viewportRef} className="tl-scroll">
          <div
            ref={trackRef}
            className="tl-tracks"
            style={{ width: width + TAIL_PX }}
            {...scrub}
          >
            <div className="tk" style={{ height: rows.ruler }}>{ruler}</div>
            <div className="tk" style={{ height: rows.screen }}>
              <ScreenThumbs url={storage.fileUrl(project.tracks.screen.file)} durationUs={D}
                widthPx={x(D)} pps={pps} rowH={rows.screen} />
            </div>
            <div className="tk" style={{ height: rows.mic }}>
              {mic && <MicWave url={storage.fileUrl(mic.file)} offsetUs={mic.offsetUs} widthPx={x(D)} pps={pps} rowH={rows.mic} />}
            </div>
            <div className="tk" style={{ height: rows.zoom }}>
              {project.edits.zooms.map((z) => {
                const r = rangeOf("zoom", z.id, z);
                const sel = selection?.kind === "zoom" && selection.id === z.id;
                const w = Math.max(4, x(r.endUs - r.startUs));
                return (
                  <div
                    key={z.id}
                    data-testid={`zoom-${z.id}`}
                    onPointerDown={(e) => onBlockDown(e, "zoom", z.id, "move", z)}
                    onPointerMove={onBlockMove}
                    onPointerUp={onBlockUp}
                    className={`blk ${z.origin === "auto" ? "blk-sug" : "blk-zoom"}${sel ? " sel" : ""}`}
                    style={{ left: x(r.startUs), width: w, height: rows.zoom - 12 }}
                  >
                    <i className="g l" />
                    {w >= labelPx(labels.get(z.id) ?? "", z.origin === "ai") + 16 && (
                      <span className="lbl-ai">
                        {labels.get(z.id)}
                        {z.origin === "ai" && <b className="ai-tag">AI</b>}
                      </span>
                    )}
                    <i className="g r" />
                    {handle("zoom", z.id, "start", z, w)}
                    {handle("zoom", z.id, "end", z, w)}
                  </div>
                );
              })}
            </div>
            {vertical && (
              // Smart vertical (DESIGN-SYSTEM.md "Vertical lane"): his Frame blocks, the automatic moves as marks.
              <div className="tk" style={{ height: rows.later }} data-testid="vertical-lane">
                {aimPathFor(project, events).moves.map((m, i) => (
                  <i key={i} className="aim-move" style={{ left: x(m.startUs), width: Math.max(2, x(m.endUs - m.startUs)) }} />
                ))}
                {holds.map((h) => {
                  const r = rangeOf("frame", h.id, h);
                  const sel = selection?.kind === "frame" && selection.id === h.id;
                  const w = Math.max(4, x(r.endUs - r.startUs));
                  const pad = rows.later > 30 ? 6 : 3;
                  const label = frameLabels(holds).get(h.id) ?? "Frame";
                  return (
                    <div
                      key={h.id}
                      data-testid={`frame-${h.id}`}
                      onPointerDown={(e) => onBlockDown(e, "frame", h.id, "move", h)}
                      onPointerMove={onBlockMove}
                      onPointerUp={onBlockUp}
                      className={`blk blk-frame${sel ? " sel" : ""}`}
                      style={{ left: x(r.startUs), width: w, top: pad, height: rows.later - 2 * pad }}
                    >
                      <i className="g l" />
                      {w >= labelPx(label, false) + 16 && <span>{label}</span>}
                      <i className="g r" />
                      {handle("frame", h.id, "start", h, w)}
                      {handle("frame", h.id, "end", h, w)}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Cursor blocks (DESIGN-SYSTEM.md "Cursor lane"): the layout block's geometry, paper fill. */}
            <div className="tk" style={{ height: rows.later }} data-testid="cursor-lane">
              {curSecs.map((cs) => {
                const r = rangeOf("cursor", cs.id, cs);
                const sel = selection?.kind === "cursor" && selection.id === cs.id;
                const w = Math.max(4, x(r.endUs - r.startUs));
                const pad = rows.later > 30 ? 6 : 3;
                const label = cursorBlockLabel(cs);
                return (
                  <div
                    key={cs.id}
                    data-testid={`cursor-${cs.id}`}
                    onPointerDown={(e) => onBlockDown(e, "cursor", cs.id, "move", cs)}
                    onPointerMove={onBlockMove}
                    onPointerUp={onBlockUp}
                    className={`blk blk-cur${sel ? " sel" : ""}`}
                    style={{ left: x(r.startUs), width: w, top: pad, height: rows.later - 2 * pad }}
                  >
                    <i className="g l" />
                    {w >= labelPx(label, false) + 16 && <span>{label}</span>}
                    <i className="g r" />
                    {handle("cursor", cs.id, "start", cs, w)}
                    {handle("cursor", cs.id, "end", cs, w)}
                  </div>
                );
              })}
            </div>
            {laterLanes.map((name) =>
              name === "System audio" && sys ? (
                // The computer's sound keeps the System audio lane's place and height.
                <div key={name} className="tk" style={{ height: rows.later }}>
                  <MicWave url={storage.fileUrl(sys.file)} offsetUs={sys.offsetUs} widthPx={x(D)} pps={pps} rowH={rows.later} />
                </div>
              ) : name === "Camera" && cam ? (
                // The camera keeps the Camera lane's place and height, with the Screen lane's thumbnails.
                <div key={name} className="tk" style={{ height: rows.later }}>
                  <ScreenThumbs url={storage.fileUrl(cam.file)} durationUs={D} widthPx={x(D)} pps={pps} rowH={rows.later} />
                </div>
              ) : name === "Layout" && cam ? (
                // Layout scenes (DESIGN-SYSTEM.md "Layout lane"): zoom-block geometry, paper or Live accent.
                <div key={name} className="tk" style={{ height: rows.later }}>
                  {scenes.map((sc) => {
                    const r = rangeOf("layout", sc.id, sc);
                    const sel = selection?.kind === "layout" && selection.id === sc.id;
                    const w = Math.max(4, x(r.endUs - r.startUs));
                    const pad = rows.later > 30 ? 6 : 3;
                    const label = LAYOUT_LABEL[sc.layout];
                    return (
                      <div
                        key={sc.id}
                        data-testid={`layout-${sc.id}`}
                        onPointerDown={(e) => onBlockDown(e, "layout", sc.id, "move", sc)}
                        onPointerMove={onBlockMove}
                        onPointerUp={onBlockUp}
                        className={`blk blk-lay${sc.origin === "live" ? " live" : ""}${sel ? " sel" : ""}`}
                        style={{ left: x(r.startUs), width: w, top: pad, height: rows.later - 2 * pad }}
                      >
                        <i className="g l" />
                        {w >= labelPx(label, false) + 16 && <span>{label}</span>}
                        <i className="g r" />
                        {handle("layout", sc.id, "start", sc, w)}
                        {handle("layout", sc.id, "end", sc, w)}
                      </div>
                    );
                  })}
                </div>
              ) : name === "Drawing" && strokes.length > 0 ? (
                // One block per stroke (DESIGN-SYSTEM.md "Drawing lane"); later strokes on top.
                <div key={name} className="tk" style={{ height: rows.later }}>
                  {strokes.map((st, i) => {
                    const r = rangeOf("drawing", st.id, st);
                    const sel = selection?.kind === "drawing" && selection.id === st.id;
                    const w = Math.max(4, x(r.endUs - r.startUs));
                    const pad = rows.later > 30 ? 6 : 3;
                    const label = STROKE_LABEL[st.tool];
                    return (
                      <div
                        key={st.id}
                        data-testid={`drawing-${st.id}`}
                        onPointerDown={(e) => {
                          onBlockDown(e, "drawing", st.id, "move", st);
                          // The playhead moves into the stroke so the preview shows it.
                          const ph = useEditorStore.getState().playheadUs;
                          if (ph < st.startUs || ph >= st.endUs) seek(st.startUs + Math.min(500_000, (st.endUs - st.startUs) / 2));
                        }}
                        onPointerMove={onBlockMove}
                        onPointerUp={onBlockUp}
                        className={`blk blk-draw${sel ? " sel" : ""}`}
                        style={{ left: x(r.startUs), width: w, top: pad, height: rows.later - 2 * pad, zIndex: sel ? 3 + strokes.length : 2 + i }}
                        title={st.text ? `${label}: ${st.text}` : label}
                      >
                        <i className={`dot sw-${st.color}`} />
                        {w >= labelPx(label, false) + 24 && <span>{label}</span>}
                        <i className="g r" />
                        {handle("drawing", st.id, "start", st, w)}
                        {handle("drawing", st.id, "end", st, w)}
                      </div>
                    );
                  })}
                </div>
              ) : name === "Keys" && keyBlocks.length > 0 ? (
                // Logged shortcuts (DESIGN-SYSTEM.md "Keys lane"): the layout block's geometry, paper fill; hidden ones dashed.
                <div key={name} className="tk" style={{ height: rows.later }} data-testid="keys-lane">
                  {keyBlocks.map((k) => {
                    const r = rangeOf("key", k.id, k);
                    const sel = selection?.kind === "key" && selection.id === k.id;
                    const w = Math.max(4, x(r.endUs - r.startUs));
                    const pad = rows.later > 30 ? 6 : 3;
                    const label = keyComboLabel(k);
                    return (
                      <div
                        key={k.id}
                        data-testid={`key-${k.id}`}
                        onPointerDown={(e) => {
                          onBlockDown(e, "key", k.id, "move", k);
                          seekInto(k);
                        }}
                        onPointerMove={onBlockMove}
                        onPointerUp={onBlockUp}
                        className={`blk blk-key${k.hidden ? " hid" : ""}${sel ? " sel" : ""}`}
                        style={{ left: x(r.startUs), width: w, top: pad, height: rows.later - 2 * pad }}
                        title={label}
                      >
                        <i className="g l" />
                        {w >= labelPx(label, false) + 16 && <span>{label}</span>}
                        <i className="g r" />
                        {handle("key", k.id, "start", k, w)}
                        {handle("key", k.id, "end", k, w)}
                      </div>
                    );
                  })}
                </div>
              ) : name === "Captions" && hasWords ? (
                // The transcript words, one block each (DESIGN-SYSTEM.md "Captions lane").
                <div key={name} className="tk" style={{ height: rows.later }}>
                  {words.map((wd) => {
                    const left = x(wd.startUs);
                    const wpx = Math.max(2, x(wd.endUs - wd.startUs));
                    const text = overrides[wd.id] ?? wd.text;
                    const sel = selection?.kind === "word" && selection.id === wd.id;
                    return (
                      <div
                        key={wd.id}
                        data-testid={`word-${wd.id}`}
                        className={`cap-word${hiddenWords.has(wd.id) ? " hidden-word" : ""}${capStarts.has(wd.id) ? " cap-start" : ""}${sel ? " sel" : ""}`}
                        style={{ left, width: wpx }}
                        title={text}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          select({ kind: "word", id: wd.id });
                          seek(wd.startUs);
                        }}
                      >
                        {wpx >= text.length * 7 + 6 ? text : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div key={name} className="tk tk-later" style={{ height: rows.later }} aria-hidden="true">
                  <div className="later-box">Later</div>
                </div>
              ),
            )}

            {cutEls}

            <div data-testid="playhead" className="ph" style={{ left: x(playheadUs) }}>
              <i />
            </div>
          </div>
        </div>
      </div>
      )}
      <div className="tl-foot">
        <span>
          {count(nOwn, "zoom")} / {count(project.edits.cuts.length, "cut")} / {nAuto} suggested
          {nAi > 0 && ` / ${nAi} by AI`}
        </span>
        <span>
          {expanded ? (
            <>
              <Icon name="lock" size={12} />
              Dashed lanes are reserved for a later version
            </>
          ) : (
            <>
              <Icon name="layers" size={12} />
              G shows every lane
            </>
          )}
        </span>
      </div>
    </section>
  );
}
