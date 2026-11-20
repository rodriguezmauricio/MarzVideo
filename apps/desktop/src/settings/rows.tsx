// Rows shared by Settings and onboarding (DESIGN-SYSTEM.md "Settings": Devices and AI).
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { meterLit, METER_BARS } from "../recorder/regionMath";
import { readDeviceDefaults, store, writeDeviceDefaults, type DeviceDefaults } from "./localSettings";
import { errorText, type AiStatus, type Devices, type SettingsApi } from "./settingsApi";

/** What "Log shortcuts" records, in plain words (setup bar tooltip and Settings). */
export const KEYS_PRIVACY = "Logs shortcuts like Ctrl+S and keys like Enter or Esc, to show them on the video. Never letters you type, never in password fields.";

export function Toggle({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className="st-tog" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <i className={`st-tg${disabled ? " off" : on ? " on" : ""}`}>
        <i />
      </i>
      {label}
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Meter({ level }: { level: number }) {
  const lit = meterLit(level);
  return (
    <span className="st-meter" aria-hidden="true">
      {Array.from({ length: METER_BARS }, (_, i) => (
        <i key={i} className={i < lit ? "lit" : ""} style={{ height: [8, 11, 14, 17][i % 4] }} />
      ))}
    </span>
  );
}

export function Picker({ value, items, empty, label, onChange }: { value: string | null; items: { id: string; name: string }[]; empty: string; label: string; onChange: (id: string) => void }) {
  const current = items.find((m) => m.id === value) ?? items[0];
  return (
    <label className="st-pick">
      <span>{current ? current.name : empty}</span>
      <Icon name="down" size={12} />
      <select aria-label={label} value={current?.id ?? ""} disabled={items.length === 0} onChange={(e) => onChange(e.target.value)}>
        {items.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Microphone with the live meter, camera, computer sound: defaults for new recordings. */
export function DeviceRows({ api }: { api: SettingsApi }) {
  const [devices, setDevices] = useState<Devices | null>(null);
  const [d, setD] = useState<DeviceDefaults>(() => readDeviceDefaults(store()));
  const [level, setLevel] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.devices().then((v) => live && setDevices(v), (e) => live && setWarning(`Could not list the devices. ${errorText(e)}`));
    return () => {
      live = false;
    };
  }, [api]);

  const mics = devices?.mics ?? [];
  const micId = d.micId ?? mics.find((m) => m.default)?.id ?? mics[0]?.id ?? null;
  useEffect(() => {
    if (!devices || mics.length === 0) return;
    let stop: (() => void) | null = null;
    let live = true;
    api.meter(micId, (l) => live && setLevel(l)).then(
      (s) => (live ? (stop = s) : s()),
      () => live && setLevel(0),
    );
    return () => {
      live = false;
      stop?.();
      setLevel(0);
    };
  }, [api, devices, micId, mics.length]);

  const change = (patch: Partial<DeviceDefaults>) => setD(writeDeviceDefaults(store(), patch));
  const cams = devices?.cameras ?? [];

  return (
    <>
      <div className="st-row">
        <span className="st-label">Microphone</span>
        <div className="st-acts">
          <Picker label="Microphone" value={micId} items={mics} empty={devices ? "No microphone" : "Looking for devices..."} onChange={(id) => change({ micId: id })} />
          <Meter level={level} />
        </div>
        {warning && (
          <span className="st-why">
            <Icon name="alert" size={13} />
            {warning}
          </span>
        )}
      </div>
      <div className="st-row">
        <span className="st-label">Camera</span>
        <div className="st-acts">
          <Picker label="Camera" value={d.cameraId} items={cams} empty={devices ? "No camera" : "Looking for devices..."} onChange={(id) => change({ cameraId: id })} />
          <Toggle label="Record camera" on={d.cameraOn && cams.length > 0} disabled={cams.length === 0} onChange={(on) => change({ cameraOn: on })} />
        </div>
      </div>
      <div className="st-row">
        <span className="st-label">Computer sound</span>
        <Toggle label="Record what the computer plays" on={d.systemAudio} onChange={(on) => change({ systemAudio: on })} />
      </div>
      <div className="st-row">
        <span className="st-label">Shortcuts</span>
        <Toggle label="Log shortcuts" on={d.logKeys} onChange={(on) => change({ logKeys: on })} />
        <span className="st-why">{KEYS_PRIVACY}</span>
      </div>
    </>
  );
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Whisper, the models (with the download button: the click is his yes) and Claude Code (left out
 * in Settings, where the provider rows show it). */
export function AiRows({ api, claude = true }: { api: SettingsApi; claude?: boolean }) {
  const [s, setS] = useState<AiStatus | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.aiStatus().then((v) => live && setS(v), () => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  const download = async () => {
    setFailed(null);
    setPct(0);
    try {
      await api.downloadModels(setPct);
      setS(await api.aiStatus());
    } catch (e) {
      setFailed(`Could not download the models. ${errorText(e)}`);
    } finally {
      setPct(null);
    }
  };

  if (!s) return <div className="st-row"><span className="st-label">Checking...</span></div>;
  return (
    <>
      <div className="st-row">
        <span className="st-label">Whisper</span>
        <span className="st-value">
          {s.whisper ? (
            <>
              Found <span className="faint st-path">{s.whisper}</span>
            </>
          ) : (
            <>
              Not found. <span className="faint">Put whisper-cli.exe in {s.whisperDir ?? "the app data whisper folder"}.</span>
            </>
          )}
        </span>
      </div>
      <div className="st-row">
        <span className="st-label">Models</span>
        <span className="st-value">
          {s.modelPresent ? (
            <>
              Downloaded <span className="faint st-path">{s.modelName}, {gb(s.modelBytes)}</span>
            </>
          ) : failed ? (
            <span className="st-why">
              <Icon name="alert" size={13} />
              {failed}
            </span>
          ) : (
            "Not downloaded"
          )}
        </span>
        {!s.modelPresent && (
          <div className="st-acts">
            <button type="button" className="st-btn accent" disabled={pct !== null} onClick={() => void download()}>
              <Icon name="down" size={13} />
              {pct === null ? `Download ${gb(s.modelBytes)}` : `Downloading ${Math.round(pct * 100)}%`}
            </button>
          </div>
        )}
      </div>
      {claude && <div className="st-row">
        <span className="st-label">Claude Code</span>
        <span className="st-value">
          {s.claude ? (
            <>
              Found <span className="faint st-path">{s.claude}</span>
            </>
          ) : (
            <>
              Not found. <span className="faint">Install Claude Code and sign in.</span>
            </>
          )}
        </span>
      </div>}
    </>
  );
}
