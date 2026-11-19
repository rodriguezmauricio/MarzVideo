import { useEditorStore } from "../state/editorStore";
import { addCutAtPlayhead, addZoomAtPlayhead, deleteSelection, runAutoZoom } from "../state/actions";
import { startAiPass } from "../ai/aiActions";
import { Icon, type IconName } from "./Icon";

function LedgerRow(props: {
  icon: IconName;
  label: string;
  hotkey: string;
  onClick: () => void;
  disabled?: boolean;
  on?: boolean;
  tip?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      aria-keyshortcuts={props.hotkey}
      data-tip={props.tip}
      className={`lr2${props.on ? " on" : ""}`}
    >
      <span className="lbl">
        <Icon name={props.icon} />
        {props.label}
      </span>
      <span className="hk">{props.hotkey}</span>
    </button>
  );
}

/** The tool ledger: a vertical list of rows (or one horizontal row when the lanes are expanded). */
export function Toolbar({ horizontal = false }: { horizontal?: boolean }) {
  const playing = useEditorStore((s) => s.playing);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const history = useEditorStore((s) => s.history)!;
  const project = useEditorStore((s) => s.project);
  const selection = useEditorStore((s) => s.selection);
  const noEvents = useEditorStore((s) => s.events.length === 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const aiRunning = useEditorStore((s) => s.ai.running || s.ai.ask !== null);

  // `project` changes on every undo/redo/apply, so reading canUndo/canRedo here stays current.
  void project;

  return (
    <nav className={horizontal ? "ledger-h" : "ledger"} aria-label="Tools">
      <LedgerRow icon={playing ? "pause" : "play"} label="Play / pause" hotkey="Space" onClick={togglePlay} on />
      <LedgerRow icon="zoomadd" label="Add zoom" hotkey="Z" onClick={addZoomAtPlayhead} />
      <LedgerRow icon="cut" label="Add cut" hotkey="C" onClick={addCutAtPlayhead} />
      <LedgerRow icon="auto" label="Auto zoom" hotkey="A" onClick={runAutoZoom} disabled={noEvents} />
      <LedgerRow icon="ai" label="Edit with AI" hotkey="Shift+E" onClick={() => void startAiPass()} disabled={aiRunning}
        tip={aiRunning ? "AI edit is running" : undefined} />
      <LedgerRow icon="trash" label="Delete" hotkey="Del" onClick={deleteSelection} disabled={!selection || selection.kind === "word"} />
      <LedgerRow icon="undo" label="Undo" hotkey="Ctrl+Z" onClick={undo} disabled={!history.canUndo} />
      <LedgerRow icon="redo" label="Redo" hotkey="Ctrl+Shift+Z" onClick={redo} disabled={!history.canRedo} />
    </nav>
  );
}
