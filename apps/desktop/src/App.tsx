import { useEffect, useState } from "react";
import { Home } from "./home/Home";
import { Icon } from "./components/Icon";
import { Inspector } from "./components/Inspector";
import { Preview } from "./components/Preview";
import { mmss, mmsst } from "./components/timecode";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { WarningBar } from "./components/WarningBar";
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

/** "Projects": saves any pending edit, then goes back to Home. */
function BackLink() {
  const goHome = useAppStore((s) => s.goHome);
  return (
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
  const [lanesExpanded, setLanesExpanded] = useState(false);

  useEffect(() => {
    void load(pickStorage(dir));
  }, [load, dir]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      const s = useEditorStore.getState();
      const mod = e.ctrlKey || e.metaKey;
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
          <SaveState status={saveStatus} />
        </div>
        <div className="strip-r">
          <span className="faint">
            {project.output.width} x {project.output.height} / {project.output.fps} fps
          </span>
          {/* Export is build step 6; the button is shown but does nothing yet. */}
          <button type="button" className="export tip-left" aria-disabled="true" data-tip="Export comes in a later step">
            Export MP4
            <Icon name="down" size={14} />
          </button>
        </div>
      </header>
      {warning && <WarningBar text={warning} />}
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
