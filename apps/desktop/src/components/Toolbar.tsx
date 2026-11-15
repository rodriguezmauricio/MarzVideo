import { useEditorStore } from "../state/editorStore";
import { addCutAtPlayhead, addZoomAtPlayhead, deleteSelection, runAutoZoom } from "../state/actions";
import { Icon, type IconName } from "./Icon";

function ToolButton(props: {
  icon: IconName;
  label: string;
  hotkey: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={`${props.label} (${props.hotkey})`}
      aria-label={props.label}
      className={`flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        props.accent
          ? "bg-sky-500 font-medium text-zinc-950 hover:bg-sky-400"
          : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
      }`}
    >
      <Icon name={props.icon} />
      <span>{props.label}</span>
    </button>
  );
}

export function Toolbar() {
  const playing = useEditorStore((s) => s.playing);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const history = useEditorStore((s) => s.history)!;
  const project = useEditorStore((s) => s.project);
  const selection = useEditorStore((s) => s.selection);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  // `project` changes on every undo/redo/apply, so reading canUndo/canRedo here stays current.
  void project;

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
      <ToolButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} hotkey="Space" onClick={togglePlay} accent />
      <div className="mx-2 h-6 w-px bg-zinc-800" />
      <ToolButton icon="zoom" label="Add zoom" hotkey="Z" onClick={addZoomAtPlayhead} />
      <ToolButton icon="cut" label="Add cut" hotkey="C" onClick={addCutAtPlayhead} />
      <ToolButton icon="auto" label="Auto zoom" hotkey="A" onClick={runAutoZoom} />
      <ToolButton icon="trash" label="Delete" hotkey="Del" onClick={deleteSelection} disabled={!selection} />
      <div className="mx-2 h-6 w-px bg-zinc-800" />
      <ToolButton icon="undo" label="Undo" hotkey="Ctrl+Z" onClick={undo} disabled={!history.canUndo} />
      <ToolButton icon="redo" label="Redo" hotkey="Ctrl+Shift+Z" onClick={redo} disabled={!history.canRedo} />
    </div>
  );
}
