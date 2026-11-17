// The bar before recording: mic picker and meter, Camera (later), Hide cursor, Record, and the
// "never captured" chip. DESIGN-SYSTEM.md section 6 "Recorder: bar BEFORE recording".
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NO_FFMPEG, NO_MIC, recorderApi, type BarInfo } from "./recorderApi";
import { currentSetup, useRecorder } from "./recorderStore";
import { meterLit, METER_BARS } from "./regionMath";

const BAR_HEIGHTS = [8, 11, 14, 17];

type Phase = "setup" | "starting";

/** `placed`: drawn inside the fake overlay page at its design position (bar top at y 704). */
export function SetupBar({ placed = false }: { placed?: boolean }) {
  const api = recorderApi();
  const s = useRecorder();
  const [info, setInfo] = useState<BarInfo | null>(null);
  const [level, setLevel] = useState(0);
  const [phase, setPhase] = useState<Phase>(() => (new URLSearchParams(window.location.search).get("state") === "starting" ? "starting" : "setup"));
  const [regionError, setRegionError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);

  useEffect(() => {
    api.info().then(setInfo, () => setInfo({ mics: [], ffmpeg: true }));
    return api.onLevel(setLevel);
  }, [api]);

  const mics = info?.mics ?? [];
  const mic = mics.find((m) => m.id === s.micId) ?? mics.find((m) => m.default) ?? mics[0] ?? null;
  const micId = mic?.id ?? null;

  // The meter follows the picked mic during setup. Each start replaces the running meter in Rust
  // (serialized there), so the cleanup only drops a stale result; it does not send a stop that
  // could overtake the next start. Closing the recorder stops the meter.
  useEffect(() => {
    if (!info || phase !== "setup" || !micId) return;
    let current = true;
    api.startMeter(micId).catch(() => current && setLevel(0));
    return () => {
      current = false;
    };
  }, [api, info, micId, phase]);

  // The engine checks the region (normalize_region); the bar shows its sentence.
  const regionKey = s.mode === "full" ? "full" : `${s.region.x},${s.region.y},${s.region.w},${s.region.h}`;
  useEffect(() => {
    if (s.mode === "full") return setRegionError(null);
    let live = true;
    void api.checkRegion(s.region).then((e) => live && setRegionError(e));
    return () => {
      live = false;
    };
  }, [api, regionKey]);

  const error = info && !info.ffmpeg ? NO_FFMPEG : (regionError ?? startError ?? (info && mics.length === 0 ? NO_MIC : null));
  const blocked = !info || !info.ffmpeg || regionError !== null;

  const record = async () => {
    if (phase !== "setup" || blocked) return;
    setPhase("starting");
    setStartError(null);
    try {
      await api.record({ ...currentSetup(), micId });
    } catch (err) {
      setStartError(typeof err === "string" ? err : String(err));
      setPhase("setup");
    }
  };
  const recordRef = useRef(record);
  recordRef.current = record;

  useEffect(() => api.onRecordRequest(() => void recordRef.current()), [api]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void api.close();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyR") {
        e.preventDefault();
        void recordRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api]);

  // Size the window around the content, the bar's top edge at the design position.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const bar = barRef.current;
    if (!wrap || !bar) return;
    const fit = () => {
      setTop(bar.offsetTop);
      if (!placed) void api.fitBar(wrap.offsetWidth, wrap.offsetHeight, bar.offsetTop).catch(() => undefined);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [api, placed]);

  const lit = mics.length ? meterLit(level) : 0;

  return (
    <div ref={wrapRef} className={`rb-wrap${placed ? " placed" : ""}`} style={placed ? { top: 704 - top } : undefined}>
      <div className="rb-stack">
        {error && (
          <div className="rb-err" role="status">
            <Icon name="alert" size={13} />
            {error}
          </div>
        )}
        <div ref={barRef} className="rb-bar">
          <div className="rb-mic">
            <Icon name="mic" size={16} />
            <label className="rb-pick">
              <span className="rb-name">{mic ? mic.name : "No microphone"}</span>
              <Icon name="down" size={12} />
              <select
                aria-label="Microphone"
                value={micId ?? ""}
                disabled={!mics.length || phase !== "setup"}
                onChange={(e) => s.update({ micId: e.target.value })}
              >
                {mics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="rb-meter" aria-hidden="true">
              {Array.from({ length: METER_BARS }, (_, i) => (
                <i key={i} className={i < lit ? "lit" : undefined} style={{ height: BAR_HEIGHTS[i % 4] }} />
              ))}
            </span>
          </div>
          <i className="rb-sep" />
          <div className="rb-cam" aria-disabled="true">
            <Icon name="camera" size={16} />
            Camera
            <span className="rb-later">Not in this version</span>
            <i className="rtg off" />
          </div>
          <i className="rb-sep" />
          <button
            type="button"
            className="rb-cursor"
            role="switch"
            aria-checked={s.cursorHidden}
            disabled={phase !== "setup"}
            onClick={() => s.update({ cursorHidden: !s.cursorHidden })}
          >
            <Icon name="cursor" size={16} />
            Hide cursor
            <i className={`rtg${s.cursorHidden ? " on" : ""}`}>
              <i />
            </i>
          </button>
          <button type="button" className={`rb-rec${phase === "starting" ? " starting" : ""}`} disabled={phase !== "setup" || blocked} onClick={() => void record()}>
            <Icon name="dot" size={16} />
            {phase === "starting" ? "Starting..." : "Record"}
            <span className="hk">Ctrl+Shift+R</span>
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
