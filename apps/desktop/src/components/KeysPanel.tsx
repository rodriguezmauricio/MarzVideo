// Keys on the video in the inspector (DESIGN-SYSTEM.md "Keys" section and "Keys block selected").
import { keyComboLabel, KEYS_STYLES, keysLook, type KeyItem, type KeysPosition, type KeysSize, type KeysStyle, type Project } from "@marz/format";
import { setKeys, updateKeyItem } from "@marz/timeline";
import { deleteSelection, MIN_US } from "../state/actions";
import { useEditorStore } from "../state/editorStore";
import { Icon } from "./Icon";
import { Cell, Segmented, Toggle } from "./Inspector";
import { mmsst, seconds1 } from "./timecode";

type Row = "top" | "bottom";
type Side = "Left" | "Center" | "Right";
const ROWS: Array<[Row, string]> = [
  ["top", "Top"],
  ["bottom", "Bottom"],
];
const SIDES: Array<[Side, string]> = [
  ["Left", "Left"],
  ["Center", "Centre"],
  ["Right", "Right"],
];
const SIZES: Array<[KeysSize, string]> = [
  ["S", "S"],
  ["M", "M"],
  ["L", "L"],
];
const STYLE_NAMES: Record<KeysStyle, string> = { ink: "Ink", paper: "Paper", accent: "Accent" };

const split = (p: KeysPosition): [Row, Side] => (p.startsWith("top") ? ["top", p.slice(3) as Side] : ["bottom", p.slice(6) as Side]);

/** Project panel: show keys for the whole video, where, how big, which style. */
export function KeysBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const look = keysLook(project);
  const [row, side] = split(look.position);
  return (
    <div className="insp-cam insp-cur" data-testid="keys-block">
      <div className="mut insp-sec">Keys</div>
      <Toggle label="Show keys on the video" on={look.show} onChange={(show) => apply(setKeys({ show }))} />
      {look.show && (
        <>
          <Segmented label="Row" aria="Keys row" options={ROWS} value={row} onPick={(r) => apply(setKeys({ position: `${r}${side}` as KeysPosition }))} />
          <Segmented label="Side" aria="Keys side" options={SIDES} value={side} onPick={(s) => apply(setKeys({ position: `${row}${s}` as KeysPosition }))} />
          <Segmented label="Size" aria="Keys size" options={SIZES} value={look.size} onPick={(size) => apply(setKeys({ size }))} />
          <div className="irow">
            <span>Style</span>
            <span className="swatches" role="radiogroup" aria-label="Keys style">
              {KEYS_STYLES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={look.style === c}
                  aria-label={STYLE_NAMES[c]}
                  data-tip={STYLE_NAMES[c]}
                  className={`sw-${c}${look.style === c ? " on" : ""}`}
                  onClick={() => apply(setKeys({ style: c }))}
                />
              ))}
            </span>
          </div>
        </>
      )}
      <p className="insp-note">Shortcuts logged while recording. Select one on the timeline to hide or move it.</p>
    </div>
  );
}

/** Keys block selected: start, end, show or hide it, delete. */
export function KeysInspector({ item, durationUs }: { item: KeyItem; durationUs: number }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Pick<KeyItem, "startUs" | "endUs" | "hidden">>) => apply(updateKeyItem(item.id, p));
  return (
    <div className="insp-scroll" data-testid="keys-inspector">
      <div className="insp-head">
        <h2 className="insp-title">Keys</h2>
        <span className="badge badge-live">Live</span>
      </div>
      <div className="mut insp-sub">{keyComboLabel(item)}</div>
      <div className="cells">
        <Cell label="Start" text={mmsst(item.startUs)} onCommit={(us) => patch({ startUs: Math.max(0, Math.min(us, item.endUs - MIN_US)) })} />
        <Cell label="End" text={mmsst(item.endUs)} onCommit={(us) => patch({ endUs: Math.min(durationUs, Math.max(us, item.startUs + MIN_US)) })} />
      </div>
      <div className="toggles">
        <Toggle label="Show these keys" on={!item.hidden} onChange={(on) => patch({ hidden: !on })} />
      </div>
      <div className="irow irow-last">
        <span className="mut">Length</span>
        <span>{seconds1(item.endUs - item.startUs)}</span>
      </div>
      <p className="insp-note">Logged while recording. Hide it here, or move it on the timeline.</p>
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete block
        </button>
      </div>
    </div>
  );
}
