// Cursor and click effects in the inspector (DESIGN-SYSTEM.md "Cursor" section and "Cursor block selected").
import {
  CLICK_COLOR_LIST,
  clickSettings,
  cursorKind,
  cursorSize,
  type ClickColor,
  type ClickSize,
  type ClickStyle,
  type CursorSection,
  type CursorSize,
  type Project,
} from "@marz/format";
import { setClicks, setCursorHidden, setCursorSize, updateCursorSection } from "@marz/timeline";
import { addCursorBlockAtPlayhead, deleteSelection, MIN_US } from "../state/actions";
import { useEditorStore } from "../state/editorStore";
import { Icon } from "./Icon";
import { Cell, Segmented, Toggle } from "./Inspector";
import { mmsst, seconds1 } from "./timecode";

const SIZES: Array<[CursorSize, string]> = [
  [1, "1x"],
  [1.5, "1.5x"],
  [2, "2x"],
];
const STYLES: Array<[ClickStyle, string]> = [
  ["ripple", "Ripple"],
  ["pulse", "Pulse"],
  ["ring", "Ring"],
];
const EFFECT_SIZES: Array<[ClickSize, string]> = [
  ["S", "S"],
  ["M", "M"],
  ["L", "L"],
];
const COLOR_NAMES: Record<ClickColor, string> = { accent: "Accent", paper: "Paper", ink: "Ink" };
const BAKED_NOTE = "This recording has the cursor in the picture. It cannot be hidden or resized.";

/** Project panel: hide for the whole video, cursor size, click effects and their look. */
export function CursorBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const baked = cursorKind(project) === "baked";
  const clicks = clickSettings(project);
  return (
    <div className="insp-cam insp-cur">
      <div className="mut insp-sec">Cursor</div>
      <Toggle label="Hide cursor" on={!baked && project.edits.cursor.hidden} onChange={baked ? undefined : (on) => apply(setCursorHidden(on))} />
      <Segmented label="Cursor size" aria="Cursor size" options={SIZES} value={cursorSize(project)} disabled={baked}
        onPick={(size) => apply(setCursorSize(size))} />
      <Toggle label="Click effects" on={clicks.on} onChange={(on) => apply(setClicks({ on }))} />
      {clicks.on && (
        <>
          <Segmented label="Style" aria="Click effect style" options={STYLES} value={clicks.style} onPick={(style) => apply(setClicks({ style }))} />
          <div className="irow">
            <span>Colour</span>
            <span className="swatches" role="radiogroup" aria-label="Click effect colour">
              {CLICK_COLOR_LIST.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={clicks.color === c}
                  aria-label={COLOR_NAMES[c]}
                  data-tip={COLOR_NAMES[c]}
                  className={`sw-${c}${clicks.color === c ? " on" : ""}`}
                  onClick={() => apply(setClicks({ color: c }))}
                />
              ))}
            </span>
          </div>
          <Segmented label="Effect size" aria="Click effect size" options={EFFECT_SIZES} value={clicks.size} onPick={(size) => apply(setClicks({ size }))} />
        </>
      )}
      <div className="btns">
        <button type="button" className="fb fb-line" data-tip="Add a cursor block at the playhead / H" onClick={addCursorBlockAtPlayhead}>
          <Icon name="cursor" size={14} />
          {baked ? "Add cursor block" : "Hide cursor here"}
          <span className="fb-key">H</span>
        </button>
      </div>
      {baked && <p className="insp-note">{BAKED_NOTE}</p>}
    </div>
  );
}

/** Cursor block selected: start, end, its two switches, delete. */
export function CursorInspector({ section, durationUs, baked }: { section: CursorSection; durationUs: number; baked: boolean }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Omit<CursorSection, "id">>) => apply(updateCursorSection(section.id, p));
  return (
    <div className="insp-scroll">
      <div className="insp-head">
        <h2 className="insp-title">Cursor</h2>
        <span className="badge badge-manual">Manual</span>
      </div>
      <div className="cells">
        <Cell label="Start" text={mmsst(section.startUs)}
          onCommit={(us) => patch({ startUs: Math.max(0, Math.min(us, section.endUs - MIN_US)) })} />
        <Cell label="End" text={mmsst(section.endUs)}
          onCommit={(us) => patch({ endUs: Math.min(durationUs, Math.max(us, section.startUs + MIN_US)) })} />
      </div>
      <div className="toggles">
        <Toggle label="Hide cursor" on={!baked && section.hide} onChange={baked ? undefined : (hide) => patch({ hide })} />
        <Toggle label="Click effects" on={section.clicks} onChange={(clicks) => patch({ clicks })} />
      </div>
      <div className="irow irow-last">
        <span className="mut">Length</span>
        <span>{seconds1(section.endUs - section.startUs)}</span>
      </div>
      <p className="insp-note">{baked ? BAKED_NOTE : "Inside this block these two switches decide. Outside it, the Project panel does."}</p>
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete block
        </button>
      </div>
    </div>
  );
}
