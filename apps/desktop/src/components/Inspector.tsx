import type { Cut, Zoom } from "@marz/format";
import { setCursorHidden, updateCut, updateZoom } from "@marz/timeline";
import { deleteSelection, MIN_US } from "../state/actions";
import { useEditorStore } from "../state/editorStore";
import { Icon } from "./Icon";
import { mmsst, parseTimeUs, seconds1 } from "./timecode";
import { zoomLabels } from "./zoomLabels";

// design-check-ignore: HTMLElement.blur() drops keyboard focus; it is not a visual blur
const leaveField = (el: HTMLInputElement) => el.blur();

/** One 68px cell: small label, big display value. The value is editable; Enter or leaving the field commits it. */
function Cell(props: { label: string; text: string; onCommit: (us: number) => void }) {
  return (
    <label className="cell">
      <span className="k">{props.label}</span>
      <input
        key={props.text}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        defaultValue={props.text}
        aria-label={props.label}
        onBlur={(e) => {
          const us = parseTimeUs(e.currentTarget.value);
          if (us === null) e.currentTarget.value = props.text;
          else props.onCommit(us);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") leaveField(e.currentTarget);
          if (e.key === "Escape") {
            e.currentTarget.value = props.text;
            leaveField(e.currentTarget);
          }
        }}
      />
    </label>
  );
}

const BADGE: Record<Zoom["origin"], { text: string; cls: string }> = {
  live: { text: "Live", cls: "badge-live" },
  auto: { text: "Suggested", cls: "badge-suggested" },
  manual: { text: "Manual", cls: "badge-manual" },
};

function ZoomInspector({ zoom, title, durationUs }: { zoom: Zoom; title: string; durationUs: number }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Zoom>) => apply(updateZoom(zoom.id, p));
  const badge = BADGE[zoom.origin];
  return (
    <>
      <div className="insp-head">
        <h2 className="insp-title">{title}</h2>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="cells">
        <Cell label="Start" text={mmsst(zoom.startUs)}
          onCommit={(us) => patch({ startUs: Math.max(0, Math.min(us, zoom.endUs - MIN_US)) })} />
        <Cell label="End" text={mmsst(zoom.endUs)}
          onCommit={(us) => patch({ endUs: Math.min(durationUs, Math.max(us, zoom.startUs + MIN_US)) })} />
        <Cell label="Ease in" text={seconds1(zoom.easeInUs)} onCommit={(us) => patch({ easeInUs: Math.max(0, us) })} />
        <Cell label="Ease out" text={seconds1(zoom.easeOutUs)} onCommit={(us) => patch({ easeOutUs: Math.max(0, us) })} />
      </div>
      <div className="irow">
        <span className="mut">Motion</span>
        <span className="seg" role="radiogroup" aria-label="Motion">
          {(
            [
              ["easeInOutCubic", "Smooth"],
              ["linear", "Linear"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={zoom.easing === value}
              className={zoom.easing === value ? "on" : ""}
              onClick={() => zoom.easing !== value && patch({ easing: value })}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className="irow irow-last">
        <span className="mut">Origin</span>
        <span>{badge.text}</span>
      </div>
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete zoom
        </button>
      </div>
    </>
  );
}

function CutInspector({ cut, durationUs }: { cut: Cut; durationUs: number }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Cut>) => apply(updateCut(cut.id, p));
  return (
    <>
      <div className="insp-head">
        <h2 className="insp-title">Cut</h2>
        <span className="badge badge-cut">Removed</span>
      </div>
      <div className="cells">
        <Cell label="Start" text={mmsst(cut.startUs)}
          onCommit={(us) => patch({ startUs: Math.max(0, Math.min(us, cut.endUs - MIN_US)) })} />
        <Cell label="End" text={mmsst(cut.endUs)}
          onCommit={(us) => patch({ endUs: Math.min(durationUs, Math.max(us, cut.startUs + MIN_US)) })} />
      </div>
      <div className="irow irow-last">
        <span className="mut">Length</span>
        <span>{seconds1(cut.endUs - cut.startUs)}</span>
      </div>
      <p className="insp-note">The original recording is untouched. Delete the cut to bring this part back.</p>
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete cut
        </button>
      </div>
    </>
  );
}

function Toggle(props: { label: string; on: boolean; onChange?: (on: boolean) => void }) {
  const disabled = !props.onChange;
  return (
    <div className={`irow${disabled ? " off" : ""}`}>
      <span>{props.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={props.on}
        aria-label={props.label}
        disabled={disabled}
        className={`tg${props.on ? " on" : ""}`}
        onClick={() => props.onChange?.(!props.on)}
      >
        <i />
      </button>
    </div>
  );
}

export function Inspector({ compact = false }: { compact?: boolean }) {
  const project = useEditorStore((s) => s.project)!;
  const selection = useEditorStore((s) => s.selection);
  const apply = useEditorStore((s) => s.apply);

  const zoom = selection?.kind === "zoom" ? project.edits.zooms.find((z) => z.id === selection.id) : undefined;
  const cut = selection?.kind === "cut" ? project.edits.cuts.find((c) => c.id === selection.id) : undefined;

  return (
    <aside className="insp on-paper" aria-label="Inspector">
      {zoom ? (
        <ZoomInspector zoom={zoom} title={zoomLabels(project.edits.zooms).get(zoom.id) ?? "Zoom"} durationUs={project.durationUs} />
      ) : cut ? (
        <CutInspector cut={cut} durationUs={project.durationUs} />
      ) : (
        <>
          <h2 className="insp-title">Project</h2>
          <div className="mut insp-sub">Nothing selected</div>
          <div className="toggles">
            <Toggle label="Hide cursor" on={project.edits.cursor.hidden} onChange={(on) => apply(setCursorHidden(on))} />
            {/* Shows the stored setting; switching click effects is not built yet (see DEVIATIONS.md). */}
            <Toggle label="Click highlight" on={project.edits.clicks.effect !== "none"} />
          </div>
          {!compact && <p className="insp-note">Select a zoom or a cut on the timeline to edit it.</p>}
        </>
      )}
    </aside>
  );
}
