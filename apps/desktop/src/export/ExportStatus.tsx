import { useEffect, useRef } from "react";
import { keptSegments } from "@marz/timeline";
import { Icon } from "../components/Icon";
import { useEditorStore } from "../state/editorStore";
import { useExportStore } from "./exportStore";
import { presetSize, PRESET_ORDER } from "./exportUi";
import { refuseEmpty } from "./outputFrames";

const ICON = { youtube: "fullscreen", vertical: "portrait" } as const;

/** Export MP4 in the top strip (DESIGN-SYSTEM.md "Export"): the button and its preset panel, or
 *  "Exporting 42%" with Cancel while an export runs. */
export function ExportControl() {
  const project = useEditorStore((s) => s.project)!;
  const phase = useExportStore((s) => s.phase);
  const progress = useExportStore((s) => s.progress);
  const panel = useExportStore((s) => s.panel);
  const last = useExportStore((s) => s.last);
  const { togglePanel, closePanel, highlight, start, cancel } = useExportStore.getState();
  const wrap = useRef<HTMLDivElement>(null);
  const empty = refuseEmpty(keptSegments(project.durationUs, project.edits.cuts));

  // A click outside the button and the panel closes the panel.
  useEffect(() => {
    if (!panel.open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) closePanel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [panel.open, closePanel]);

  if (phase === "exporting")
    return (
      <div className="export-run">
        <span className="exporting" data-testid="export-progress">
          Exporting {progress}%
        </span>
        <button type="button" className="btn-line tip-left" data-tip="Cancel export. Nothing is written" onClick={cancel}>
          <Icon name="close" size={14} />
          Cancel
        </button>
      </div>
    );

  if (empty)
    return (
      <button type="button" className="export export-empty tip-left" aria-disabled="true" data-tip={empty}>
        Export MP4
        <Icon name="down" size={14} />
      </button>
    );

  return (
    <div className="export-wrap" ref={wrap}>
      <button
        type="button"
        className="export tip-left"
        aria-haspopup="menu"
        aria-expanded={panel.open}
        aria-disabled={phase === "picking" || undefined}
        data-tip={panel.open ? undefined : "Export MP4 / Ctrl+E"}
        onClick={togglePanel}
      >
        Export MP4
        <Icon name="down" size={14} />
      </button>
      {panel.open && (
        <div className="export-panel on-paper" role="menu" data-testid="export-panel">
          {PRESET_ORDER.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={`xrow${panel.highlight === p.id ? " hi" : ""}`}
              onMouseEnter={() => highlight(p.id)}
              onClick={() => void start(p.id)}
            >
              <Icon name={ICON[p.id]} size={15} />
              <span className="xlabel">{p.label}</span>
              <span className="xsize">{presetSize(p, project.source.fps)}</span>
              <i className={last === p.id ? "mark" : undefined} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The 2px accent line along the bottom of the strip while exporting. */
export function ExportProgressLine() {
  const phase = useExportStore((s) => s.phase);
  const progress = useExportStore((s) => s.progress);
  if (phase !== "exporting") return null;
  return <div className="export-line" style={{ width: `${progress}%` }} aria-hidden="true" />;
}

/** "Exported. Show in folder" for the save status slot, until the next edit or export (null otherwise). A hook: call it unconditionally. */
export function useExportDoneLine() {
  const project = useEditorStore((s) => s.project);
  const phase = useExportStore((s) => s.phase);
  const doneFor = useExportStore((s) => s.doneFor);
  if (phase !== "done" || doneFor !== project) return null;
  return (
    <span data-testid="export-done" className="save">
      <i />
      Exported.
      <a
        className="show"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          useExportStore.getState().showInFolder();
        }}
      >
        Show in folder
      </a>
    </span>
  );
}
