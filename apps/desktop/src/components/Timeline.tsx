import { useEffect, useRef, useState } from "react";
import { updateCut, updateZoom } from "@marz/timeline";
import { MIN_US } from "../state/actions";
import { useEditorStore, type Selection } from "../state/editorStore";
import { Icon } from "./Icon";
import { MicWave, ScreenThumbs } from "./Lanes";
import { count, mmss } from "./timecode";
import { handleWidthPx, MAX_TIMELINE_ZOOM, pxToUs, snapUs, timelineWidthPx, usToPx } from "./timelineMath";
import { cutCapLabel, zoomLabels } from "./zoomLabels";
import { useCaptionFacts } from "../captions/captionActions";

/** Roughly how wide a 10px mono label is, to hide labels that would not fit (micro type). */
const labelPx = (text: string, ai: boolean) => text.length * 7 + (ai ? 26 : 0) + 8;

type Kind = "zoom" | "cut";
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
  const real = (name: string) => (name === "System audio" && !!sys) || (name === "Camera" && !!cam) || (name === "Captions" && hasWords);
  const nAuto = project.edits.zooms.filter((z) => z.origin === "auto").length;
  const nOwn = project.edits.zooms.length - nAuto;
  const nAi = project.edits.zooms.filter((z) => z.origin === "ai").length + project.edits.cuts.filter((c) => c.origin === "ai").length;
  const words = useEditorStore((s) => s.words);
  const hasWords = words.length > 0;
  const overrides = project.edits.captions?.overrides ?? {};
  const hiddenWords = new Set(project.edits.captions?.hidden ?? []);
  const capStarts = useCaptionFacts().starts;

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
          <button type="button" className="bx bx-lanes" aria-pressed={expanded} onClick={onToggleLanes}>
            <Icon name="layers" size={13} />
            {expanded ? "Hide lanes" : "Show lanes"}
          </button>
        </span>
      </div>
      <div className="tl-body">
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
          {LATER_LANES.map((name) =>
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
            onPointerDown={(e) => {
              select(null);
              scrubbing.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              seekFromEvent(e.clientX);
            }}
            onPointerMove={(e) => scrubbing.current && seekFromEvent(e.clientX)}
            onPointerUp={() => (scrubbing.current = false)}
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
            {LATER_LANES.map((name) =>
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

            {project.edits.cuts.map((c) => {
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
            })}

            <div data-testid="playhead" className="ph" style={{ left: x(playheadUs) }}>
              <i />
            </div>
          </div>
        </div>
      </div>
      <div className="tl-foot">
        <span>
          {count(nOwn, "zoom")} / {count(project.edits.cuts.length, "cut")} / {nAuto} suggested
          {nAi > 0 && ` / ${nAi} by AI`}
        </span>
        <span>
          <Icon name="lock" size={12} />
          Dashed lanes are reserved for a later version
        </span>
      </div>
    </section>
  );
}
