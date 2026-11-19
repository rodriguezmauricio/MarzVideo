import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { WarningBar } from "../components/WarningBar";
import { matchesCombo } from "../settings/hotkeyMap";
import { hotkeyNow, useHotkey } from "../settings/hotkeyStore";
import { useAppStore } from "../state/appStore";
import { pickStorage } from "../storage/pickStorage";
import { bannerText, folderName, toRows, type ProjectRow, type RowView } from "./projectRows";
import { projectsApi, type StorageApi } from "./projectsApi";
import { ThemeButton } from "./ThemeButton";
import { storageBar, type ArchiveSettings, type StorageButtonId, type StorageStep, type StorageView } from "./storageBar";

const NOT_A_PROJECT = "This folder is not a Marz project. Pick a folder that ends in .marz.";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A frame of the recording, 96 x 54. The app hands a small cached picture; a browser loads the video. */
function Thumb({ dir, load }: { dir: string; load?: (dir: string) => Promise<string> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    setSrc(null);
    load(dir).then(
      (url) => live && setSrc(url),
      (err) => console.warn("thumbnail", dir, err),
    );
    return () => {
      live = false;
    };
  }, [dir, load]);
  return (
    <div className="h-thumb">
      {load ? (
        src && <img src={src} alt="" draggable={false} />
      ) : (
        <video src={`${pickStorage(dir).fileUrl("screen.mp4")}#t=0.5`} preload="metadata" muted playsInline tabIndex={-1} />
      )}
    </div>
  );
}

function Row({
  row,
  onOpen,
  thumb,
  storageOpen,
  onStorage,
}: {
  row: RowView;
  onOpen: () => void;
  thumb?: (dir: string) => Promise<string>;
  storageOpen: boolean;
  onStorage: () => void;
}) {
  return (
    <div className="h-row">
      <button type="button" className="h-row-main" onClick={onOpen}>
        <span className="h-idx">{row.index}</span>
        <Thumb dir={row.dir} load={thumb} />
        <span className="h-name">{row.name}</span>
        <span className="h-len">{row.length}</span>
        <span className="h-meta">
          {row.badge && <i className={`badge ${row.badge === "Archived" ? "badge-manual" : "badge-line"} h-badge`}>{row.badge}</i>}
          <span className="h-meta-text">{row.meta}</span>
        </span>
      </button>
      <button type="button" className={`h-store${storageOpen ? " on" : ""}`} aria-expanded={storageOpen} onClick={onStorage}>
        <Icon name="archive" size={13} />
        Storage
      </button>
      <button type="button" className="h-open" onClick={onOpen}>
        Open
        <Icon name="down" size={13} turn={-90} />
      </button>
    </div>
  );
}

const ERROR_LEAD: Record<"archive" | "remove" | "restore" | "folder", string> = {
  archive: "Could not archive.",
  remove: "Could not remove the raw files.",
  restore: "Could not restore.",
  folder: "Could not set the archive folder.",
};

/** The storage bar under a row (DESIGN-SYSTEM.md Home, "Storage"): archive, remove raw files, restore. */
function StorageBar({
  row,
  api,
  settings,
  onSettings,
  onClose,
  onChanged,
  onBusy,
}: {
  row: RowView;
  api: StorageApi;
  settings: ArchiveSettings;
  onSettings: (s: ArchiveSettings) => void;
  onClose: () => void;
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [view, setView] = useState<StorageView | null>(null);
  const [busy, setBusy] = useState<{ step: StorageStep; pct: number } | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<{ lead: string; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.view(row.dir).then(
      (v) => live && setView(v),
      (e) => live && setError({ lead: ERROR_LEAD.archive, text: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, row.dir]);

  useEffect(() => api.onProgress((p) => p.dir === row.dir && setBusy({ step: p.step, pct: p.pct })), [api, row.dir]);
  useEffect(() => onBusy(busy !== null), [busy, onBusy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async (kind: keyof typeof ERROR_LEAD, first: StorageStep, job: () => Promise<StorageView>) => {
    setError(null);
    setAsking(false);
    setBusy({ step: first, pct: 0 });
    try {
      setView(await job());
    } catch (e) {
      setError({ lead: ERROR_LEAD[kind], text: message(e) });
      api.view(row.dir).then(setView, () => undefined);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const folder = async (job: () => Promise<unknown>) => {
    try {
      setError(null);
      await job();
      onSettings(await api.settings());
    } catch (e) {
      setError({ lead: ERROR_LEAD.folder, text: message(e) });
    }
  };

  const press = (id: StorageButtonId) => {
    if (id === "close") onClose();
    else if (id === "keep") setAsking(false);
    else if (id === "remove") {
      setError(null);
      setAsking(true);
    } else if (id === "useSuggested") void folder(api.useSuggested);
    else if (id === "pick") void folder(api.pickDest);
    else if (id === "archive") void run("archive", "copying", () => api.archive(row.dir));
    else if (id === "confirmRemove") void run("remove", "proxies", () => api.removeRaw(row.dir));
    else if (id === "restore") void run("restore", "restoring", () => api.restore(row.dir));
  };

  if (!view) return <div className="h-banner h-storebar" role="status" />;
  const bar = storageBar({ name: row.name, settings, view, busy, asking, error });
  return (
    <div className="h-banner h-storebar" role="status">
      <span className="h-banner-text">
        <b>{bar.lead}</b> <span className="faint">{bar.rest}</span>
      </span>
      {bar.buttons.map((b) => (
        <button key={b.id} type="button" className={`h-btn ${b.accent ? "h-btn-accent" : "h-btn-line"}`} onClick={() => press(b.id)}>
          {b.label}
        </button>
      ))}
    </div>
  );
}

/** "Interrupted: <name>. The video up to 03:12 is safe." Discard asks first, in the same bar. */
function RecoverBanner({ row, onRecover, onDiscard }: { row: ProjectRow; onRecover: () => void; onDiscard: () => void }) {
  const [asking, setAsking] = useState(false);
  const { lead, rest } = bannerText(row);
  return (
    <div className="h-banner" role="status">
      <i className="h-hatch" aria-hidden="true" />
      {asking ? (
        <>
          <span className="h-banner-text">
            <b>Move {row.name} to the Recycle Bin?</b> <span className="faint">You can restore it from there.</span>
          </span>
          <button type="button" className="h-btn h-btn-line" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className="h-btn h-btn-line" onClick={() => setAsking(false)}>
            Keep
          </button>
        </>
      ) : (
        <>
          <span className="h-banner-text">
            <b>{lead}</b> <span className="faint">{rest}</span>
          </span>
          <button type="button" className="h-btn h-btn-accent" onClick={onRecover}>
            Recover
          </button>
          <button type="button" className="h-btn h-btn-line" onClick={() => setAsking(true)}>
            Discard
          </button>
        </>
      )}
    </div>
  );
}

function HeroButtons({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  const recordKey = useHotkey("recordStop");
  return (
    <div className="h-cta">
      <button type="button" className="h-new" data-tip={`New recording / ${recordKey}`} onClick={onNew}>
        <Icon name="dot" size={16} />
        New recording
        <span className="h-hk">{recordKey}</span>
      </button>
      <button type="button" className="h-openp" onClick={onOpen}>
        <Icon name="folder" size={16} />
        Open a project
      </button>
    </div>
  );
}

const TRACKS = ["Screen", "Mic", "Clicks"];

export function Home() {
  const api = useMemo(projectsApi, []);
  const openProject = useAppStore((s) => s.openProject);
  const openSettings = useAppStore((s) => s.openSettings);
  const recordKey = useHotkey("recordStop");
  const [raw, setRaw] = useState<ProjectRow[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  /** The row whose storage bar is open (one at a time), the archive folder setting, a running step. */
  const [storageFor, setStorageFor] = useState<string | null>(null);
  const [settings, setSettings] = useState<ArchiveSettings | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const toggleStorage = (key: string) => {
    if (storageBusy) return;
    setStorageFor((cur) => (cur === key ? null : key));
    if (!settings) api.storage.settings().then(setSettings, (err) => setWarning(`Could not read the archive settings. ${message(err)}`));
  };

  const refresh = useCallback(async () => {
    try {
      setRaw(await api.list());
    } catch (err) {
      setRaw([]);
      setWarning(`Could not read the projects folder. ${message(err)}`);
    }
  }, [api]);

  useEffect(() => void refresh(), [refresh]);

  // A recording whose files could not be finished: the sentence here, its recover banner below.
  useEffect(
    () =>
      api.onRecordingFailed((text) => {
        setWarning(text);
        void refresh();
      }),
    [api, refresh],
  );

  const newRecording = useCallback(() => void api.openRecorder().catch((err) => setWarning(message(err))), [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesCombo(e, hotkeyNow("recordStop"))) {
        e.preventDefault();
        newRecording();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newRecording]);

  const recoverAndOpen = async (dir: string, name: string) => {
    try {
      setWarning(null);
      await api.recover(dir);
      openProject(dir);
    } catch (err) {
      setWarning(`Could not recover ${name}. ${message(err)}`);
    }
  };

  const openFolder = async () => {
    try {
      const picked = await api.pick();
      if (picked.kind === "cancelled") return;
      if (picked.kind === "notProject") return setWarning(NOT_A_PROJECT);
      setWarning(null);
      if (picked.needsRecovery) await recoverAndOpen(picked.dir, folderName(picked.dir));
      else openProject(picked.dir);
    } catch (err) {
      setWarning(`Could not open the folder. ${message(err)}`);
    }
  };

  const discard = async (row: ProjectRow) => {
    try {
      await api.discard(row.dir);
      setWarning(null);
    } catch (err) {
      setWarning(`Could not move ${row.name} to the Recycle Bin. ${message(err)}`);
    }
    await refresh();
  };

  if (raw === null) return <div className="msg">Reading projects...</div>;

  const banners = raw.filter((r) => r.needs_recovery);
  const rows = toRows(raw, new Date());
  const empty = raw.length === 0;

  return (
    <div className="home">
      <div className="grid-lines" aria-hidden="true" />
      <header className="strip">
        <b className="h-brand">
          <i />
          Marz Recorder
        </b>
        <span className="h-strip-end">
          <ThemeButton />
          <button type="button" className="h-settings" onClick={openSettings}>
            <Icon name="gear" size={14} />
            Settings
          </button>
        </span>
      </header>
      {warning && <WarningBar text={warning} />}
      {empty ? (
        <main className="h-empty">
          <h1 className="h-empty-title">
            Nothing
            <br />
            yet.
          </h1>
          <p className="h-empty-text">Press {recordKey} from anywhere to start. Your recordings appear here, ready to edit.</p>
          <HeroButtons onNew={newRecording} onOpen={() => void openFolder()} />
          <div className="h-tracks">
            <div className="h-tracks-head">Every recording is saved as separate tracks</div>
            {TRACKS.map((t) => (
              <div key={t} className="h-track">
                <span>{t}</span>
                <div>Appears here after you record</div>
              </div>
            ))}
          </div>
        </main>
      ) : (
        <>
          <section className="h-hero on-paper">
            <div className="grid-lines grid-on-paper" aria-hidden="true" />
            <h1 className="h-title">Record once.</h1>
            <p className="h-lede">Screen, camera, mic, computer sound and clicks are kept as separate tracks. Zooms, cuts, layouts, captions and drawings sit on top as edits. Nothing is baked in, so fix and polish afterwards.</p>
            <HeroButtons onNew={newRecording} onOpen={() => void openFolder()} />
          </section>
          {banners.map((b) => (
            <RecoverBanner key={b.dir + b.name} row={b} onRecover={() => void recoverAndOpen(b.dir, b.name)} onDiscard={() => void discard(b)} />
          ))}
          <div className="h-head">
            <span>Recent projects</span>
            <span>Last edited, newest first</span>
          </div>
          <div className="h-rows">
            {rows.map((r) => {
              const key = r.dir + r.index;
              const open = storageFor === key;
              return (
                <div key={key}>
                  <Row
                    row={r}
                    thumb={api.thumb}
                    storageOpen={open}
                    onStorage={() => toggleStorage(key)}
                    // A storage step on this project must finish before it opens.
                    onOpen={() => !(open && storageBusy) && openProject(r.dir)}
                  />
                  {open && settings && (
                    <StorageBar
                      row={r}
                      api={api.storage}
                      settings={settings}
                      onSettings={setSettings}
                      onClose={() => setStorageFor(null)}
                      onChanged={() => void refresh()}
                      onBusy={setStorageBusy}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
