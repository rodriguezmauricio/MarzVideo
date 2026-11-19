import { useEffect, useState } from "react";
import { verticalEdits, type Project, type VerticalHold } from "@marz/format";
import { setVertical, updateHold } from "@marz/timeline";
import { Cell, Segmented } from "../components/Inspector";
import { Icon } from "../components/Icon";
import { mmsst, seconds1 } from "../components/timecode";
import { deleteSelection, MIN_US } from "../state/actions";
import { useEditorStore } from "../state/editorStore";
import { holdFrameHere } from "./verticalActions";

/** "42%": an aim as a share of the screen width, left to right. */
export const aimLabel = (x: number) => `${Math.round(x * 100)}%`;

/** Aim slider (the Pace slider): 0 to 100% in 1% steps; one drag or key press is one undo step. */
function AimRow({ hold }: { hold: VerticalHold }) {
  const apply = useEditorStore((s) => s.apply);
  const [shown, setShown] = useState(hold.x);
  useEffect(() => setShown(hold.x), [hold.x]);
  const commit = (v: number) => apply(updateHold(hold.id, { x: v / 100 }));
  return (
    <div className="irow">
      <span>Aim</span>
      <span className="pace">
        Left
        <input
          key={`${hold.id}-${hold.x}`}
          type="range"
          min={0}
          max={100}
          step={1}
          defaultValue={Math.round(hold.x * 100)}
          aria-label="Aim"
          onChange={(e) => setShown(Number(e.currentTarget.value) / 100)}
          onPointerUp={(e) => commit(Number(e.currentTarget.value))}
          onKeyUp={(e) => commit(Number(e.currentTarget.value))}
        />
        Right
      </span>
      <span className="pace-val">{aimLabel(shown)}</span>
    </div>
  );
}

/** A Frame block selected: start, end, aim, delete. */
export function FrameInspector({ hold, title, durationUs }: { hold: VerticalHold; title: string; durationUs: number }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Pick<VerticalHold, "startUs" | "endUs">>) => apply(updateHold(hold.id, p));
  return (
    <div className="insp-scroll">
      <div className="insp-head">
        <h2 className="insp-title">{title}</h2>
        <span className="badge badge-manual">Manual</span>
      </div>
      <div className="cells">
        <Cell label="Start" text={mmsst(hold.startUs)} onCommit={(us) => patch({ startUs: Math.max(0, Math.min(us, hold.endUs - MIN_US)) })} />
        <Cell label="End" text={mmsst(hold.endUs)} onCommit={(us) => patch({ endUs: Math.min(durationUs, Math.max(us, hold.startUs + MIN_US)) })} />
      </div>
      <div className="insp-vert">
        <AimRow hold={hold} />
        <div className="irow">
          <span className="mut">Length</span>
          <span>{seconds1(hold.endUs - hold.startUs)}</span>
        </div>
      </div>
      <p className="insp-note">Holds the vertical frame here. Outside frame blocks it follows the action by itself.</p>
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete frame
        </button>
      </div>
    </div>
  );
}

/** Vertical block of the Project panel: framing, camera slot, hold the frame here. */
export function VerticalBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const v = verticalEdits(project);
  const camShown = !!project.tracks.camera;
  return (
    <div className="insp-vert">
      <div className="mut insp-sec">Vertical</div>
      <Segmented
        aria="Vertical framing"
        label="Framing"
        options={[
          ["follow", "Follow"],
          ["fit", "Fit"],
        ]}
        value={v.framing}
        onPick={(framing) => apply(setVertical({ framing }))}
      />
      {camShown && (
        <Segmented
          aria="Vertical camera slot"
          label="Camera"
          options={[
            ["top", "Top"],
            ["bottom", "Bottom"],
          ]}
          value={v.cameraSlot}
          onPick={(cameraSlot) => apply(setVertical({ cameraSlot }))}
        />
      )}
      {v.framing === "follow" && (
        <div className="btns">
          <button type="button" className="fb fb-line" onClick={() => holdFrameHere()}>
            <Icon name="portrait" size={14} />
            Hold frame here
            <span className="fb-key">F</span>
          </button>
        </div>
      )}
      <div className="insp-last">
        {v.framing === "follow"
          ? `Follows the action. ${v.holds.length === 1 ? "1 frame block" : `${v.holds.length} frame blocks`}.`
          : "Fits the whole picture with bars."}
      </div>
    </div>
  );
}

/** "Frame 1", "Frame 2" by start time. */
export function frameLabels(holds: VerticalHold[]): Map<string, string> {
  return new Map(holds.map((h, i) => [h.id, `Frame ${i + 1}`]));
}
