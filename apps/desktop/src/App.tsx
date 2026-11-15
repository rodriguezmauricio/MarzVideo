import { useEffect } from "react";
import { Inspector } from "./components/Inspector";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { addCutAtPlayhead, addZoomAtPlayhead, deleteSelection, runAutoZoom } from "./state/actions";
import { flushAutosave, useEditorStore } from "./state/editorStore";

const fmt = (us: number) => {
  const s = us / 1e6;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

export function App() {
  const status = useEditorStore((s) => s.status);
  const error = useEditorStore((s) => s.error);
  const project = useEditorStore((s) => s.project);
  const playheadUs = useEditorStore((s) => s.playheadUs);
  const load = useEditorStore((s) => s.load);
  const warning = useEditorStore((s) => s.warning);
  const saveStatus = useEditorStore((s) => s.saveStatus);

  useEffect(() => {
    void load(new URLSearchParams(location.search).get("project") ?? "demo");
  }, [load]);

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

  if (status === "error") return <div className="p-6 text-red-400">Could not open the project: {error}</div>;
  if (status !== "ready" || !project) return <div className="p-6 text-zinc-400">Opening project...</div>;

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
        <span className="font-semibold">{project.name}</span>
        <span className="tabular-nums text-zinc-400" data-testid="clock">
          {fmt(playheadUs)} / {fmt(project.durationUs)}
        </span>
        <span
          data-testid="save-status"
          className={`ml-auto text-xs ${saveStatus === "error" ? "text-red-400" : "text-zinc-500"}`}
        >
          {{ saved: "All changes saved", unsaved: "Unsaved changes", saving: "Saving...", error: "Save failed, retrying" }[saveStatus]}
        </span>
      </header>
      {warning && <div className="border-b border-amber-900 bg-amber-950 px-4 py-1.5 text-xs text-amber-200">{warning}</div>}
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <Preview />
        <Inspector />
      </div>
      <Timeline />
    </div>
  );
}
