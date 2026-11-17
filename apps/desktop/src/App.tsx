import { useEffect, useState } from "react";
import { ExportControl, ExportProgressLine, useExportDoneLine } from "./export/ExportStatus";
import { useExportStore } from "./export/exportStore";
import { Home } from "./home/Home";
import { Icon } from "./components/Icon";
import { Inspector } from "./components/Inspector";
import { Preview } from "./components/Preview";
import { mmss, mmsst } from "./components/timecode";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { WarningBar } from "./components/WarningBar";
import { keptSegments } from "@marz/timeline";
import { refuseEmpty } from "./export/outputFrames";
import { addCutAtPlayhead, addZoomAtPlayhead, deleteSelection, runAutoZoom } from "./state/actions";
import { useAppStore } from "./state/appStore";
import { flushAutosave, useEditorStore } from "./state/editorStore";
import { pickStorage } from "./storage/pickStorage";
import type { SaveStatus } from "./storage/autosave";

/** Save status: three states (DESIGN-SYSTEM.md "Save status"). A pending debounced save counts as saving. */
function SaveState({ status }: { status: SaveStatus }) {
  if (status === "error")
    return (
      <span data-testid="save-status" className="save save-failed">
        <Icon name="alert" size={13} />
        Save failed. Retrying...
      </span>
    );
  const saved = status === "saved";
  return (
    <span data-testid="save-status" className={`save${saved ? "" : " save-pending"}`}>
      <i />
      {saved ? "All changes saved" : "Saving..."}
    </span>
  );
}

/** Home or the editor (appStore). */
export function App() {
  const screen = useAppStore((s) => s.screen);
  const dir = useAppStore((s) => s.dir);
  return screen === "editor" && dir ? <Editor key={dir} dir={dir} /> : <Home />;
}

/** "Projects": saves any pending edit, then goes back to Home. Faint while an export runs. */
function BackLink() {
  const goHome = useAppStore((s) => s.goHome);
  const busy = useExportStore((s) => s.phase === "picking" || s.phase === "exporting");
  return (
    <a
      className={busy ? "back off" : "back"}
      href="#"
      aria-disabled={busy || undefined}
      data-tip={busy ? "Cancel or wait for the export first" : undefined}
      onClick={(e) => {
        e.preventDefault();
        if (!busy) void goHome();
      }}
    >
      <Icon name="back" size={14} />
      Projects
    </a>
  );
}

function Editor({ dir }: { dir: string }) {
  const status = useEditorStore((s) => s.status);
  const error = useEditorStore((s) => s.error);
  const project = useEditorStore((s) => s.project);
  const playheadUs = useEditorStore((s) => s.playheadUs);
  const load = useEditorStore((s) => s.load);
  const warning = useEditorStore((s) => s.warning);
  const saveStatus = useEditorStore((s) => s.saveStatus);
  const exportFailure = useExportStore((s) => (s.phase === "failed" ? s.failure : null));
  const exportDone = useExportDoneLine();
  const [lanesExpanded, setLanesExpanded] = useState(false);

  useEffect(() => {
    void load(pickStorage(dir));
    // Leaving the editor cancels a running export (nothing is written).
    return () => useExportStore.getState().reset();
  }, [load, dir]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      const s = useEditorStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const ex = useExportStore.getState();
      // The open preset panel takes Enter, Esc and the arrows (DESIGN-SYSTEM.md "Export").
      if (!mod && !e.altKey && ex.key(e.code)) {
        e.preventDefault();
        return;
      }
      if (mod && e.code === "KeyE") {
        e.preventDefault();
        const p = s.project;
        if (p && !refuseEmpty(keptSegments(p.durationUs, p.edits.cuts))) ex.togglePanel();
        return;
      }
      if (mod && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.code === "KeyY") {
        e.preventDefault();
        s.redo();
      } else if (mod || e.altKey) {
        return;
      } else if (e.code === "Space") {
        e.preventDefault();
        s.togglePlay();
      } else if (e.code === "KeyZ") addZoomAtPlayhead();
      else if (e.code === "KeyC") addCutAtPlayhead();
      else if (e.code === "KeyA") runAutoZoom();
      else if (e.code === "Delete" || e.code === "Backspace") deleteSelection();
      else if (e.code === "Escape") s.select(null);
    };
    const onUnload = () => void flushAutosave();
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  if (status === "error")
    return (
      <div className="msg">
        <BackLink />
        <div className="msg-error" role="alert">
          <Icon name="alert" size={13} />
          Could not open the project: {error}
        </div>
      </div>
    );
  if (status !== "ready" || !project) return <div className="msg">Opening project...</div>;

  return (
    <div className={`app${lanesExpanded ? " expanded" : ""}`}>
      <div className="grid-lines" aria-hidden="true" />
      <header className="strip">
        <div className="strip-l">
          <BackLink />
          <span className="faint">/</span>
          <b className="proj">{project.name}</b>
          {exportDone ?? <SaveState status={saveStatus} />}
        </div>
        <div className="strip-r">
          <span className="faint">
            {project.output.width} x {project.output.height} / {project.output.fps} fps
          </span>
          <ExportControl />
        </div>
        <ExportProgressLine />
      </header>
      {(exportFailure ?? warning) && <WarningBar text={(exportFailure ?? warning)!} />}
      {lanesExpanded && <Toolbar horizontal />}
      <main className="main">
        <div className="timecode" aria-hidden="true">
          {mmss(playheadUs)}
        </div>
        <div className="playline" data-testid="clock">
          Playhead {mmsst(playheadUs)} / Length {mmsst(project.durationUs)}
        </div>
        {!lanesExpanded && <Toolbar />}
        <Preview />
        <Inspector compact={lanesExpanded} />
      </main>
      <Timeline expanded={lanesExpanded} onToggleLanes={() => setLanesExpanded((v) => !v)} />
    </div>
  );
}
