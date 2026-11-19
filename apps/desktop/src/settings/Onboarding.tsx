// The intro on the first start (DESIGN-SYSTEM.md section 6 "Onboarding"): four short screens,
// skippable, shown once (settings.json `onboardingDone`), reopened from Settings.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useAppStore } from "../state/appStore";
import { rangeLabel, type ActionId } from "./hotkeyMap";
import { useHotkeys } from "./hotkeyStore";
import { AiRows, DeviceRows } from "./rows";
import { settingsApi } from "./settingsApi";

const STEPS = ["What Marz records", "Mic and camera", "Hotkeys", "AI editing"] as const;

const TRACKS: { icon: IconName; name: string; file: string; text: string }[] = [
  { icon: "window", name: "Screen", file: "screen.mp4", text: "The picture, 60 fps." },
  { icon: "mic", name: "Mic", file: "mic.wav", text: "Your voice." },
  { icon: "speaker", name: "Computer sound", file: "system.wav", text: "What the computer plays. Off by default." },
  { icon: "camera", name: "Camera", file: "camera.mp4", text: "Your face, on the same clock. Off by default." },
  { icon: "cursor", name: "Cursor and clicks", file: "events.jsonl", text: "Drawn by the editor, so you can hide or enlarge them." },
];

const KEYS: { name: string; ids: ActionId[] }[] = [
  { name: "Record and stop", ids: ["recordStop"] },
  { name: "Pause and resume", ids: ["pause"] },
  { name: "Mute mic", ids: ["mute"] },
  { name: "Zoom to a preset", ids: ["preset1", "preset9"] },
  { name: "Zoom out", ids: ["zoomOut"] },
  { name: "Draw on screen", ids: ["draw"] },
  { name: "Tick next topic", ids: ["check"] },
  { name: "Camera layouts", ids: ["layout1", "layout4"] },
];

function Screen({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <>
      <h1 className="ob-title">{title}</h1>
      <p className="ob-lede">{lede}</p>
      <div className="ob-rows">{children}</div>
    </>
  );
}

export function Onboarding() {
  const api = useMemo(settingsApi, []);
  const goHome = useAppStore((s) => s.goHome);
  const bindings = useHotkeys((s) => s.bindings);
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;

  const finish = () => {
    void api.setOnboardingDone(true).catch(() => undefined);
    void goHome();
  };
  const next = () => (last ? finish() : setStep(step + 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.code === "Enter" && !(el.tagName === "BUTTON" && !el.classList.contains("ob-next"))) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="st">
      <div className="grid-lines" aria-hidden="true" />
      <header className="strip">
        <b className="h-brand">
          <i />
          Marz Recorder
        </b>
        <button type="button" className="ob-skip" onClick={finish}>
          Skip intro
          <span className="hk">Esc</span>
        </button>
      </header>
      <main className="st-main">
        <nav className="st-left" aria-label="Intro steps">
          <div className="st-ledger ob-ledger">
            {STEPS.map((s, i) => (
              <button
                key={s}
                type="button"
                className={`st-led${i === step ? " on" : i < step ? " done" : " later"}`}
                aria-current={i === step ? "step" : undefined}
                disabled={i > step}
                onClick={() => setStep(i)}
              >
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                {s}
              </button>
            ))}
          </div>
          <p className="ob-step" aria-hidden="true">
            {String(step + 1).padStart(2, "0")}
          </p>
        </nav>
        <div className="ob-right">
          {step === 0 && (
            <Screen title="Every part on its own track." lede="Marz keeps each part of a take in its own file, so you can fix one without touching the rest. Nothing is baked in.">
              {TRACKS.map((t) => (
                <div key={t.name} className="st-row ob-track">
                  <span className="ob-track-name">
                    <Icon name={t.icon} size={16} />
                    {t.name}
                  </span>
                  <span className="ob-file">{t.file}</span>
                  <span className="faint">{t.text}</span>
                </div>
              ))}
            </Screen>
          )}
          {step === 1 && (
            <Screen title="Your mic and camera." lede="Pick what new recordings use. Talk and watch the meter.">
              <DeviceRows api={api} />
            </Screen>
          )}
          {step === 2 && (
            <Screen title="Keys that work anywhere." lede="While the recorder is open these work over any app. Change them in Settings.">
              {KEYS.map((k) => (
                <div key={k.name} className="st-row short">
                  <span className="st-label">{k.name}</span>
                  <span className="st-value">{rangeLabel(bindings, k.ids)}</span>
                </div>
              ))}
            </Screen>
          )}
          {step === 3 && (
            <Screen
              title="Edit with AI. Optional."
              lede="After you stop, Marz can cut silences and ums, find mistakes and write captions. Speech is turned into text on this computer."
            >
              <AiRows api={api} />
            </Screen>
          )}
        </div>
      </main>
      <div className="ob-cta">
        {step > 0 && (
          <button type="button" className="ob-back" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button type="button" className="ob-next" onClick={next}>
          {last ? "Start recording" : "Next"}
          <span className="hk">Enter</span>
          <Icon name="down" size={16} turn={-90} />
        </button>
      </div>
    </div>
  );
}
