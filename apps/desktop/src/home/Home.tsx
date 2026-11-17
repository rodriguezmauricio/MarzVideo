import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { WarningBar } from "../components/WarningBar";
import { useAppStore } from "../state/appStore";
import { pickStorage } from "../storage/pickStorage";
import { bannerText, folderName, toRows, type ProjectRow, type RowView } from "./projectRows";
import { projectsApi } from "./projectsApi";

const NOT_A_PROJECT = "This folder is not a Marz project. Pick a folder that ends in .marz.";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A frame of the recording, 96 x 54. */
function Thumb({ dir }: { dir: string }) {
  return (
    <div className="h-thumb">
      <video src={`${pickStorage(dir).fileUrl("screen.mp4")}#t=0.5`} preload="metadata" muted playsInline tabIndex={-1} />
    </div>
  );
}

function Row({ row, onOpen }: { row: RowView; onOpen: () => void }) {
  return (
    <button type="button" className="h-row" onClick={onOpen}>
      <span className="h-idx">{row.index}</span>
      <Thumb dir={row.dir} />
      <span className="h-name">{row.name}</span>
      <span className="h-len">{row.length}</span>
      <span className="h-meta">{row.meta}</span>
      <span className="h-open">
        Open
        <Icon name="down" size={13} turn={-90} />
      </span>
    </button>
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
  return (
    <div className="h-cta">
      <button type="button" className="h-new" data-tip="New recording / Ctrl+Shift+R" onClick={onNew}>
        <Icon name="dot" size={16} />
        New recording
        <span className="h-hk">Ctrl+Shift+R</span>
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
  const [raw, setRaw] = useState<ProjectRow[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRaw(await api.list());
    } catch (err) {
      setRaw([]);
      setWarning(`Could not read the projects folder. ${message(err)}`);
    }
  }, [api]);

  useEffect(() => void refresh(), [refresh]);

  const newRecording = useCallback(() => void api.openRecorder().catch((err) => setWarning(message(err))), [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyR") {
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
        {/* Settings is a later milestone: drawn as in the mockup, does nothing yet. */}
        <button type="button" className="h-settings tip-left" aria-disabled="true" data-tip="Settings come in a later version">
          <Icon name="gear" size={14} />
          Settings
        </button>
      </header>
      {warning && <WarningBar text={warning} />}
      {empty ? (
        <main className="h-empty">
          <h1 className="h-empty-title">
            Nothing
            <br />
            yet.
          </h1>
          <p className="h-empty-text">Press Ctrl+Shift+R from anywhere to start. Your recordings appear here, ready to edit.</p>
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
            <p className="h-lede">Screen, mic and clicks are kept as separate tracks. Nothing is baked in, so fix and polish afterwards.</p>
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
            {rows.map((r) => (
              <Row key={r.dir + r.index} row={r} onOpen={() => openProject(r.dir)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
