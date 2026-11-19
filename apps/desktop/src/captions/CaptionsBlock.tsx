import { captionStyleFor, type CaptionPosition, type CaptionPresetId, type CaptionSize, type CaptionStyleName, type Project } from "@marz/format";
import { setCaptionStyle } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";

function Seg<T extends string>(props: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onPick: (v: T) => void; four?: boolean }) {
  return (
    <div className="irow">
      <span>{props.label}</span>
      <span className={`seg${props.four ? " seg-4" : ""}`} role="radiogroup" aria-label={`Caption ${props.label.toLowerCase()}`}>
        {props.options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={props.value === v} className={props.value === v ? "on" : ""} onClick={() => props.value !== v && props.onPick(v)}>
            {text}
          </button>
        ))}
      </span>
    </div>
  );
}

const PRESETS: ReadonlyArray<readonly [CaptionPresetId, string]> = [
  ["youtube", "YouTube"],
  ["vertical", "Vertical"],
];
const STYLES: ReadonlyArray<readonly [CaptionStyleName, string]> = [
  ["inkBand", "Ink"],
  ["paperBand", "Paper"],
  ["accentBand", "Accent"],
  ["plain", "Plain"],
];
const SIZES: ReadonlyArray<readonly [CaptionSize, string]> = [
  ["S", "S"],
  ["M", "M"],
  ["L", "L"],
];
const POSITIONS: ReadonlyArray<readonly [CaptionPosition, string]> = [
  ["top", "Top"],
  ["middle", "Middle"],
  ["bottom", "Bottom"],
];

/** Captions block of the Project panel (DESIGN-SYSTEM.md Inspector, "Captions block"): the caption
 * style of one export preset. The preview shows the preset picked here. */
export function CaptionsBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const preset = useEditorStore((s) => s.captionPreset);
  const setPreset = useEditorStore((s) => s.setCaptionPreset);
  const st = captionStyleFor(project, preset);
  const patch = (p: Parameters<typeof setCaptionStyle>[1]) => apply(setCaptionStyle(preset, p));
  return (
    <div className="insp-caps" data-testid="captions-block">
      <div className="mut insp-sec">Captions</div>
      <Seg label="For" value={preset} options={PRESETS} onPick={setPreset} />
      <Seg label="Style" value={st.style} options={STYLES} onPick={(style) => patch({ style })} four />
      <Seg label="Size" value={st.size} options={SIZES} onPick={(size) => patch({ size })} />
      <Seg label="Position" value={st.position} options={POSITIONS} onPick={(position) => patch({ position })} />
      <div className="irow k34">
        <span>Word highlight</span>
        <button
          type="button"
          role="switch"
          aria-checked={st.highlight}
          aria-label="Word highlight"
          className={`tg${st.highlight ? " on" : ""}`}
          onClick={() => patch({ highlight: !st.highlight })}
        >
          <i />
        </button>
      </div>
      <div className="insp-last">Burn captions is set per preset in the export panel.</div>
    </div>
  );
}
