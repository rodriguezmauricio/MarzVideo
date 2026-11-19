// Settings (DESIGN-SYSTEM.md section 6 "Settings"): every setting the app has, in one place.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { WarningBar } from "../components/WarningBar";
import { useAppStore } from "../state/appStore";
import { ACTIONS, comboFromEvent, comboProblem, DEFAULT_BINDINGS, type ActionId, type Bindings } from "./hotkeyMap";
import { useHotkeys } from "./hotkeyStore";
import {
  AI_MODELS,
  EXPORT_PRESET_IDS,
  presetLabel,
  readAiModel,
  readBurnCaptions,
  readDefaultPreset,
  store,
  writeAiModel,
  writeBurnCaptions,
  writeDefaultPreset,
  type AiModel,
} from "./localSettings";
import { AiRows, DeviceRows, Seg, Toggle } from "./rows";
import { errorText, settingsApi, type FolderKind, type SettingsView } from "./settingsApi";

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "folders", label: "Folders", icon: "folder" },
  { id: "devices", label: "Devices", icon: "mic" },
  { id: "hotkeys", label: "Hotkeys", icon: "layers" },
  { id: "ai", label: "AI", icon: "ai" },
  { id: "captions", label: "Captions", icon: "captions" },
  { id: "export", label: "Export", icon: "down" },
];

function Folders({ view, run }: { view: SettingsView; run: (job: () => Promise<SettingsView | null>) => void }) {
  const api = settingsApi();
  const row = (label: string, kind: FolderKind, path: string | null, isDefault: boolean) => (
    <div className="st-row">
      <span className="st-label">{label}</span>
      <span className="st-value" title={path ?? undefined}>
        {path ? <span className="st-path">{path}</span> : <span className="faint">Not set</span>}
      </span>
      <div className="st-acts">
        {kind === "archive" && !path && view.archiveSuggested && (
          <button type="button" className="st-btn accent" onClick={() => run(() => api.useDrive())} title={view.archiveSuggested}>
            Use Google Drive
          </button>
        )}
        <button type="button" className="st-btn" onClick={() => run(() => api.pickFolder(kind))}>
          <Icon name="folder" size={13} />
          Change
        </button>
        {kind !== "archive" && !isDefault && (
          <button type="button" className="st-btn" onClick={() => run(() => api.resetFolder(kind))}>
            Use default
          </button>
        )}
      </div>
    </div>
  );
  return (
    <>
      {row("Projects", "projects", view.projectsDir, view.projectsDefault)}
      {row("Exports", "exports", view.exportsDir, view.exportsDefault)}
      {row("Archive", "archive", view.archiveDir, true)}
      <p className="st-last">Recordings already in a folder stay there. Open them with Open a project.</p>
    </>
  );
}

function Hotkeys({ armed, setArmed, problem }: { armed: ActionId | null; setArmed: (id: ActionId | null) => void; problem: { id: ActionId; text: string } | null }) {
  const bindings = useHotkeys((s) => s.bindings);
  const reset = (id: ActionId) => void saveHotkeys({ ...bindings, [id]: DEFAULT_BINDINGS[id] }).catch(() => undefined);
  return (
    <>
      {ACTIONS.map((a) => (
        <div key={a.id} className="st-row short">
          <span className="st-label">{a.name}</span>
          <button type="button" className={`st-key${armed === a.id ? " armed" : ""}`} aria-label={`${a.name}: ${bindings[a.id]}. Change`} onClick={() => setArmed(armed === a.id ? null : a.id)}>
            {armed === a.id ? "Press the keys" : bindings[a.id]}
          </button>
          {bindings[a.id] !== a.combo && armed !== a.id && (
            <button type="button" className="st-text" onClick={() => reset(a.id)}>
              Use default
            </button>
          )}
          {problem?.id === a.id && (
            <span className="st-why" role="alert">
              <Icon name="alert" size={13} />
              {problem.text}
            </span>
          )}
        </div>
      ))}
    </>
  );
}

/** Saves all bindings in Rust and shows the result everywhere. Throws the sentence when refused. */
async function saveHotkeys(all: Bindings): Promise<void> {
  const v = await settingsApi().setHotkeys(all);
  useHotkeys.getState().set(v.hotkeys);
}

function Captions() {
  const [burn, setBurn] = useState(() => Object.fromEntries(EXPORT_PRESET_IDS.map((id) => [id, readBurnCaptions(store(), id)])));
  return (
    <>
      {EXPORT_PRESET_IDS.map((id) => (
        <div key={id} className="st-row">
          <span className="st-label">Burn captions: {presetLabel(id)}</span>
          <Toggle
            label={burn[id] ? "On" : "Off"}
            on={!!burn[id]}
            onChange={(on) => {
              writeBurnCaptions(store(), id, on);
              setBurn({ ...burn, [id]: on });
            }}
          />
        </div>
      ))}
      <p className="st-last">Caption style is set per project in the inspector.</p>
    </>
  );
}

function ExportDefaults() {
  const [preset, setPreset] = useState(() => readDefaultPreset(store()));
  return (
    <>
      <div className="st-row">
        <span className="st-label">Default preset</span>
        <Seg
          label="Default preset"
          value={preset}
          options={EXPORT_PRESET_IDS.map((id) => ({ id, label: presetLabel(id) }))}
          onChange={(id) => {
            writeDefaultPreset(store(), id);
            setPreset(id);
          }}
        />
      </div>
      <p className="st-last">The export panel opens on this preset.</p>
    </>
  );
}

function AiModelRow() {
  const [model, setModel] = useState<AiModel>(() => readAiModel(store()));
  return (
    <div className="st-row">
      <span className="st-label">Model</span>
      <Seg
        label="AI model"
        value={model}
        options={AI_MODELS.map((m) => ({ id: m, label: m === "opus" ? "Opus" : "Sonnet" }))}
        onChange={(m) => {
          writeAiModel(store(), m);
          setModel(m);
        }}
      />
    </div>
  );
}

export function Settings() {
  const api = useMemo(settingsApi, []);
  const goHome = useAppStore((s) => s.goHome);
  const openOnboarding = useAppStore((s) => s.openOnboarding);
  const [view, setView] = useState<SettingsView | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [current, setCurrent] = useState("folders");
  const [armed, setArmed] = useState<ActionId | null>(null);
  const [problem, setProblem] = useState<{ id: ActionId; text: string } | null>(null);
  const right = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get().then(
      (v) => {
        setView(v);
        useHotkeys.getState().set(v.hotkeys);
      },
      (e) => setWarning(`Could not read the settings. ${errorText(e)}`),
    );
  }, [api]);

  const run = useCallback((job: () => Promise<SettingsView | null>) => {
    setWarning(null);
    job().then(
      (v) => v && setView(v),
      (e) => setWarning(errorText(e)),
    );
  }, []);

  const jump = (id: string) => {
    document.getElementById(`st-${id}`)?.scrollIntoView({ block: "start" });
    setCurrent(id);
  };

  const onScroll = () => {
    const box = right.current;
    if (!box) return;
    // A section is on screen once its head passes the top third of the column.
    const top = box.getBoundingClientRect().top + box.clientHeight / 3;
    let on = SECTIONS[0]!.id;
    for (const s of SECTIONS) {
      const el = document.getElementById(`st-${s.id}`);
      if (el && el.getBoundingClientRect().top <= top) on = s.id;
    }
    // At the bottom the last section counts as on screen even when it is short.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) on = SECTIONS[SECTIONS.length - 1]!.id;
    setCurrent(on);
  };

  // Keys: an armed hotkey box takes the next combo; otherwise 1 to 6 jump, Esc goes back to Home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (armed) {
        e.preventDefault();
        e.stopPropagation();
        if (e.code === "Escape") return setArmed(null);
        const combo = comboFromEvent(e);
        if (!combo) return; // only modifiers so far
        const all = useHotkeys.getState().bindings;
        const why = comboProblem(armed, combo, all);
        setArmed(null);
        if (why) return setProblem({ id: armed, text: why });
        setProblem(null);
        saveHotkeys({ ...all, [armed]: combo }).catch((err) => setProblem({ id: armed, text: errorText(err) }));
        return;
      }
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === "Escape") void goHome();
      const n = /^Digit([1-6])$/.exec(e.code);
      if (n) jump(SECTIONS[Number(n[1]) - 1]!.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [armed, goHome]);

  const bindings = useHotkeys((s) => s.bindings);
  const anyRebound = ACTIONS.some((a) => bindings[a.id] !== a.combo);

  return (
    <div className="st">
      <div className="grid-lines" aria-hidden="true" />
      <header className="strip">
        <div className="strip-l">
          <a
            className="back"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void goHome();
            }}
          >
            <Icon name="back" size={14} />
            Projects
          </a>
          <span className="faint">/</span>
          <span className="proj">Settings</span>
        </div>
      </header>
      {warning && <WarningBar text={warning} />}
      <h1 className="st-title">Settings.</h1>
      <main className="st-main">
        <nav className="st-left" aria-label="Settings sections">
          <div className="st-ledger">
            {SECTIONS.map((s, i) => (
              <button key={s.id} type="button" className={`st-led${current === s.id ? " on" : ""}`} aria-current={current === s.id || undefined} onClick={() => jump(s.id)}>
                <Icon name={s.icon} size={14} />
                {s.label}
                <span className="hk">{i + 1}</span>
              </button>
            ))}
          </div>
          <button type="button" className="st-btn st-intro" onClick={openOnboarding}>
            <Icon name="play" size={13} />
            Show the intro again
          </button>
        </nav>
        <div className="st-right" ref={right} onScroll={onScroll}>
          <section className="st-sec" id="st-folders">
            <div className="st-head">
              <b>Folders</b>
              <span className="st-head-r">Where recordings and exports go</span>
            </div>
            {view ? <Folders view={view} run={run} /> : <div className="st-row"><span className="st-label">Reading...</span></div>}
          </section>
          <section className="st-sec" id="st-devices">
            <div className="st-head">
              <b>Devices</b>
              <span className="st-head-r">Defaults for new recordings. The setup bar can still change them.</span>
            </div>
            <DeviceRows api={api} />
          </section>
          <section className="st-sec" id="st-hotkeys">
            <div className="st-head">
              <b>Hotkeys</b>
              <span className="st-head-r">
                Work while the recorder is open.
                {anyRebound && (
                  <button type="button" className="st-text" onClick={() => void saveHotkeys({ ...DEFAULT_BINDINGS }).then(() => setProblem(null))}>
                    Reset all
                  </button>
                )}
              </span>
            </div>
            <Hotkeys armed={armed} setArmed={(id) => (setProblem(null), setArmed(id))} problem={problem} />
          </section>
          <section className="st-sec" id="st-ai">
            <div className="st-head">
              <b>AI</b>
              <span className="st-head-r">Optional. Recording and editing work without it.</span>
            </div>
            <AiRows api={api} />
            <AiModelRow />
          </section>
          <section className="st-sec" id="st-captions">
            <div className="st-head">
              <b>Captions</b>
              <span className="st-head-r">Defaults for every export</span>
            </div>
            <Captions />
          </section>
          <section className="st-sec" id="st-export">
            <div className="st-head">
              <b>Export</b>
              <span className="st-head-r">Defaults for every export</span>
            </div>
            <ExportDefaults />
          </section>
        </div>
      </main>
    </div>
  );
}
