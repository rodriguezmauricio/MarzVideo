// Settings > AI: which provider the AI pass and the checklist use (DESIGN-SYSTEM.md "Settings", AI;
// design docs/superpowers/specs/2026-11-19-ai-provider-design.md). The API key goes straight to
// Windows Credential Manager through Rust and never comes back to this page.
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { AI_MODELS, readAiModel, store, writeAiModel, type AiModel } from "./localSettings";
import { Seg } from "./rows";
import { errorText, type AiConfig, type ProviderId, type ProviderView, type SettingsApi, type TestResult } from "./settingsApi";

export const PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "anthropic", label: "Anthropic API" },
  { id: "local", label: "Local" },
  { id: "off", label: "Off" },
];

const API_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
] as const;

const SENT = "Only text leaves the app: the transcript words with their times, the silence cuts, click times for zooms and your checklist topics. Never video, audio, screenshots or file paths.";

/** The plain sentence about what is sent, for the picked provider. */
export function sentText(p: ProviderId): string {
  if (p === "off") return "Nothing is sent. Silences and ums are still cut on this computer.";
  const where = p === "claude-code" ? "Goes through your Claude subscription." : p === "anthropic" ? "Billed per use to your API account." : "Stays on the computer at that address.";
  return `${SENT} ${where}`;
}

const config = (v: ProviderView): AiConfig => ({ provider: v.provider, anthropicModel: v.anthropicModel, localUrl: v.localUrl, localModel: v.localModel });

function Why({ text }: { text: string }) {
  return (
    <span className="st-why" role="alert">
      <Icon name="alert" size={13} />
      {text}
    </span>
  );
}

/** Leaves the field (commits it). */
// design-check-ignore: HTMLElement.blur() drops keyboard focus; it is not a visual blur
const leaveField = (el: HTMLInputElement) => el.blur();

/** A text field that commits on Enter or when it is left. */
function Field({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }) {
  return (
    <input
      key={value}
      className="st-field"
      type="text"
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      defaultValue={value}
      onBlur={(e) => e.currentTarget.value.trim() !== value && onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") leaveField(e.currentTarget);
        if (e.key === "Escape") {
          e.currentTarget.value = value;
          leaveField(e.currentTarget);
        }
        e.stopPropagation();
      }}
    />
  );
}

function ClaudeModel() {
  const [model, setModel] = useState<AiModel>(() => readAiModel(store()));
  return (
    <Seg
      label="Claude Code model"
      value={model}
      options={AI_MODELS.map((m) => ({ id: m, label: m === "opus" ? "Opus" : "Sonnet" }))}
      onChange={(m) => {
        writeAiModel(store(), m);
        setModel(m);
      }}
    />
  );
}

function KeyRow({ v, api, onView }: { v: ProviderView; api: SettingsApi; onView: (v: ProviderView) => void }) {
  const [draft, setDraft] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const save = () => {
    setWhy(null);
    api.saveAiKey(draft).then(
      (nv) => {
        setDraft("");
        onView(nv);
      },
      (e) => setWhy(errorText(e)),
    );
  };
  return (
    <div className="st-row">
      <span className="st-label">API key</span>
      {v.keySaved ? (
        <span className="st-value">
          Saved in Windows Credential Manager <span className="faint">ends in <span className="st-path">{v.keyLast4}</span></span>
        </span>
      ) : (
        <input
          className="st-field grow"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="Anthropic API key"
          placeholder="sk-ant-..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) save();
            e.stopPropagation();
          }}
        />
      )}
      <div className="st-acts">
        {v.keySaved ? (
          <button type="button" className="st-btn" onClick={() => api.removeAiKey().then(onView, (e) => setWhy(errorText(e)))}>
            <Icon name="trash" size={13} />
            Remove
          </button>
        ) : (
          <button type="button" className="st-btn accent" disabled={!draft.trim()} onClick={save}>
            <Icon name="lock" size={13} />
            Save
          </button>
        )}
      </div>
      {why && <Why text={why} />}
    </div>
  );
}

/** Provider, its own rows, Test connection and what is sent. */
export function AiProviderRows({ api }: { api: SettingsApi }) {
  const [v, setV] = useState<ProviderView | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | "running" | null>(null);

  useEffect(() => {
    let live = true;
    api.aiProvider().then((x) => live && setV(x), (e) => live && setWhy(`Could not read the AI settings. ${errorText(e)}`));
    return () => {
      live = false;
    };
  }, [api]);

  const show = (nv: ProviderView) => {
    setV(nv);
    setTest(null);
  };
  const change = (patch: Partial<AiConfig>) => {
    if (!v) return;
    setWhy(null);
    api.setAiProvider({ ...config(v), ...patch }).then(show, (e) => setWhy(errorText(e)));
  };
  const runTest = () => {
    setTest("running");
    api.testAiProvider().then(setTest, (e) => setTest({ ok: false, text: errorText(e) }));
  };

  if (!v) return <div className="st-row">{why ? <Why text={why} /> : <span className="st-label">Checking...</span>}</div>;
  return (
    <>
      <div className="st-row">
        <span className="st-label">Provider</span>
        <Seg label="AI provider" value={v.provider} options={PROVIDERS} onChange={(provider) => change({ provider })} />
        {why && <Why text={why} />}
      </div>
      {v.provider === "claude-code" && (
        <>
          <div className="st-row">
            <span className="st-label">Claude Code</span>
            <span className="st-value">
              {v.claude ? (
                <>
                  Found <span className="faint st-path">{v.claude}</span>
                </>
              ) : (
                <>
                  Not found. <span className="faint">Install Claude Code and sign in.</span>
                </>
              )}
            </span>
          </div>
          <div className="st-row">
            <span className="st-label">Model</span>
            <ClaudeModel />
          </div>
        </>
      )}
      {v.provider === "anthropic" && (
        <>
          <KeyRow v={v} api={api} onView={show} />
          <div className="st-row">
            <span className="st-label">Model</span>
            <Seg label="Anthropic model" value={v.anthropicModel} options={API_MODELS} onChange={(anthropicModel) => change({ anthropicModel })} />
            <span className="faint">The checklist uses Haiku 5.5</span>
          </div>
        </>
      )}
      {v.provider === "local" && (
        <>
          <div className="st-row">
            <span className="st-label">Address</span>
            <Field label="Local AI address" value={v.localUrl} placeholder="http://localhost:11434" onCommit={(localUrl) => change({ localUrl })} />
            <span className="faint">Ollama, LM Studio or any OpenAI compatible server</span>
          </div>
          <div className="st-row">
            <span className="st-label">Model</span>
            <Field label="Local model name" value={v.localModel} placeholder="llama3.1" onCommit={(localModel) => change({ localModel })} />
          </div>
        </>
      )}
      {v.provider !== "off" && (
        <div className="st-row">
          <span className="st-label">Connection</span>
          <div className="st-acts">
            <button type="button" className="st-btn" disabled={test === "running"} onClick={runTest}>
              <Icon name="ai" size={13} />
              {test === "running" ? "Testing..." : "Test connection"}
            </button>
          </div>
          {test && test !== "running" &&
            (test.ok ? (
              <span className="st-why">
                <Icon name="check" size={13} />
                {test.text}
              </span>
            ) : (
              <Why text={test.text} />
            ))}
        </div>
      )}
      <div className="st-row">
        <span className="st-label">What is sent</span>
        <span className="st-value wrap">{sentText(v.provider)}</span>
      </div>
    </>
  );
}
