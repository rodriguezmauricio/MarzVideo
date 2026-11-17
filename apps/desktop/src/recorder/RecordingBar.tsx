// The bar while recording: rec square and timer, Pause, Mute mic with meter, one button per zoom
// preset, Zoom out, Stop. DESIGN-SYSTEM.md section 6 "Recorder: bar WHILE recording", mockup
// Recorder-Recording.dc.html. Every button calls the same Rust function as its global hotkey.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { recorderApi } from "./recorderApi";
import { useRecLive } from "./recLive";
import { sessionPresetId, useRecorder } from "./recorderStore";
import { meterLit, METER_BARS } from "./regionMath";
import { SetupBar } from "./SetupBar";
import { formatTimer } from "./timer";

const BAR_HEIGHTS = [8, 11, 14, 17];
/** The bar's top edge while recording, at 1440 x 900. */
const BAR_TOP = 716;

/** The bar window's content: the setup until Rust reports Recording, then the recording bar. */
export function Bar({ placed = false }: { placed?: boolean }) {
  const recording = useRecLive((l) => l.rec.recording);
  return recording ? <RecordingBar placed={placed} /> : <SetupBar placed={placed} />;
}

/** The design's tooltip over a bar button ("Zoom to Cart total / Ctrl+1"), shown on hover or focus. */
function Tip({ id, text, tip }: { id: string; text: string; tip: string | null }) {
  return tip === id ? <span className="rr-tip">{text}</span> : null;
}

export function RecordingBar({ placed = false }: { placed?: boolean }) {
  const api = recorderApi();
  const rec = useRecLive((l) => l.rec);
  const warning = useRecLive((l) => l.warning);
  const presets = useRecorder((s) => s.presets);
  const [level, setLevel] = useState(0);
  const [tip, setTip] = useState<string | null>(null);
  // While the pointer is over the bar window, the window grows 28px upward so a tooltip fits above
  // the bar. The page is anchored to the window's bottom and Rust keeps the bar's top in place, so
  // nothing moves under the pointer. Not while it is out: that strip would take clicks.
  const [room, setRoom] = useState(false);
  const [stopping, setStopping] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);

  useEffect(() => api.onLevel(setLevel), [api]);

  // Esc does nothing while recording (Stop or Ctrl+Shift+R ends it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Size the window around the content, the bar's top edge at the recording position.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const bar = barRef.current;
    if (!wrap || !bar) return;
    const fit = () => {
      setTop(bar.offsetTop);
      if (!placed) void api.fitBar(wrap.offsetWidth, wrap.offsetHeight, bar.offsetTop, true).catch(() => undefined);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap, { box: "border-box" }); // the tooltip room is padding: watch the border box
    return () => ro.disconnect();
  }, [api, placed]);

  const hover = (id: string) => ({
    onPointerEnter: () => setTip(id),
    onPointerLeave: () => setTip((t) => (t === id ? null : t)),
    onFocus: () => setTip(id),
    onBlur: () => setTip((t) => (t === id ? null : t)),
  });
  const tipProps = { tip };
  const lit = rec.mic && !rec.muted ? meterLit(level) : 0;
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    api.stop().catch(() => setStopping(false));
  };

  return (
    <div
      ref={wrapRef}
      className={`rb-wrap rec${room ? " tipping" : ""}${placed ? " placed" : ""}`}
      style={placed ? { top: BAR_TOP - top } : undefined}
      onPointerEnter={placed ? undefined : () => setRoom(true)}
      onPointerLeave={placed ? undefined : () => setRoom(false)}
    >
      <div className="rb-stack">
        {warning && (
          <div className="rb-err" role="status">
            <Icon name="alert" size={13} />
            {warning}
          </div>
        )}
        <div ref={barRef} className="rb-bar rr-bar">
          <span className="rr-time" role="timer" aria-label="Recording time">
            <i className="rr-sq" />
            <b>{formatTimer(rec.recUs)}</b>
          </span>
          <button
            type="button"
            className={`rr-b${rec.paused ? " on" : ""}`}
            onClick={() => void (rec.paused ? api.resume() : api.pause()).catch(() => undefined)}
            {...hover("pause")}
          >
            <Icon name={rec.paused ? "play" : "pause"} size={16} />
            {/* Both words in one cell, so the button keeps its width and nothing moves. */}
            <span className="rr-swap">
              <span className={rec.paused ? "off" : undefined}>Pause</span>
              <span className={rec.paused ? undefined : "off"}>Resume</span>
            </span>
            <Tip id="pause" text={`${rec.paused ? "Resume" : "Pause"} / Ctrl+Shift+P`} {...tipProps} />
          </button>
          <button
            type="button"
            className={`rr-b${rec.muted ? " on" : ""}`}
            aria-label={rec.muted ? "Unmute mic" : "Mute mic"}
            aria-pressed={rec.muted}
            disabled={!rec.mic}
            onClick={() => void api.setMuted(!rec.muted).catch(() => undefined)}
            {...hover("mute")}
          >
            <Icon name={rec.muted ? "micoff" : "mic"} size={16} />
            {/* Both words in one cell, so the button keeps its width and nothing moves. */}
            <span className="rr-swap">
              <span className={rec.muted ? "off" : undefined}>Mute</span>
              <span className={rec.muted ? undefined : "off"}>Unmute</span>
            </span>
            {/* Unlit while muted or without a mic. */}
            <span className="rb-meter" aria-hidden="true">
              {Array.from({ length: METER_BARS }, (_, i) => (
                <i key={i} className={i < lit ? "lit" : undefined} style={{ height: BAR_HEIGHTS[i % 4] }} />
              ))}
            </span>
            <Tip id="mute" text={rec.mic ? `${rec.muted ? "Unmute mic" : "Mute mic"} / Ctrl+Shift+M` : "Recording without a mic"} {...tipProps} />
          </button>
          <i className="rb-sep" />
          {presets.map((p) => {
            const id = sessionPresetId(p.id);
            const on = rec.activePreset === id;
            return (
              <button
                key={p.id}
                type="button"
                className={`rr-b${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() => void api.zoom(id).catch(() => undefined)}
                {...hover(id)}
              >
                <Icon name="zoomadd" size={16} />
                <b>{p.id}</b>
                {p.name}
                <Tip id={id} text={`Zoom to ${p.name} / Ctrl+${p.id}`} {...tipProps} />
              </button>
            );
          })}
          <button type="button" className="rr-b" onClick={() => void api.zoom(null).catch(() => undefined)} {...hover("out")}>
            <Icon name="zoomout" size={16} />
            Zoom out
            <Tip id="out" text="Zoom out / Ctrl+0" {...tipProps} />
          </button>
          <i className="rb-sep" />
          <button type="button" className="rr-stop" disabled={stopping} onClick={stop} {...hover("stop")}>
            <Icon name="stop" size={14} />
            Stop
            <Tip id="stop" text="Stop and open in the editor / Ctrl+Shift+R" {...tipProps} />
          </button>
        </div>
      </div>
      <div className="rb-chip">
        <Icon name="eyeoff" size={13} />
        Both bars are never captured in the recording
      </div>
    </div>
  );
}
