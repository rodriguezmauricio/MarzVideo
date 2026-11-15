import { useEffect } from "react";
import { Preview } from "./components/Preview";
import { useEditorStore } from "./state/editorStore";

const fmt = (us: number) => {
  const s = us / 1e6;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

export function App() {
  const { status, error, project, playing, playheadUs, load, togglePlay } = useEditorStore();

  useEffect(() => {
    void load(new URLSearchParams(location.search).get("project") ?? "demo");
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  if (status === "error") return <div className="p-6 text-red-400">Could not open the project: {error}</div>;
  if (status !== "ready" || !project) return <div className="p-6 text-zinc-400">Opening project...</div>;

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
        <span className="font-semibold">{project.name}</span>
        <button
          onClick={togglePlay}
          title="Play / pause (Space)"
          className="rounded bg-sky-500 px-3 py-1 font-medium text-zinc-950 hover:bg-sky-400"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span className="tabular-nums text-zinc-400">
          {fmt(playheadUs)} / {fmt(project.durationUs)}
        </span>
      </header>
      <Preview />
    </div>
  );
}
