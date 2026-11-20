import { AudioBlock } from "./AudioBlock";
import { BackgroundBlock } from "./BackgroundBlock";
import { LookBlock } from "../looks/LookBlock";
import { hasChecklist } from "@marz/format";
import { ChecklistPanel } from "../checklist/ChecklistPanel";
import { CursorBlock, CursorInspector } from "./CursorPanel";
import { useEffect, useState } from "react";
import { aiEdits, BORDER_COLOR_NAMES, cursorKind, cursorSections, drawingStrokes, STROKE_COLORS, strokeWidths, type Stroke, type StrokeColor, cameraBorder, cameraEdits, cameraScenes, captionEdits, LAYOUT_KINDS, PIP_CORNERS, PIP_SIZES, type BorderColor, type Corner, type Cut, type PipShape, type Project, type Scene, type Word, type Zoom } from "@marz/format";
import { setCaptionHidden, setCaptionText, updateCamera, updateCut, updateScene, updateStroke, updateZoom, type StrokePatch } from "@marz/timeline";
import { setKind, setPace } from "../ai/aiActions";
import { CaptionsBlock } from "../captions/CaptionsBlock";
import { setCaptionStartAt, useCaptionFacts, wordCaptionState } from "../captions/captionActions";
import { TranscriptPanel } from "../captions/TranscriptPanel";
import { deleteSelection, MIN_US } from "../state/actions";
import { useEditorStore } from "../state/editorStore";
import { Icon } from "./Icon";
import { editedTimeUs, mmsst, seconds1 } from "./timecode";
import { cutCapLabel, LAYOUT_LABEL, STROKE_LABEL, zoomLabels } from "./zoomLabels";
import { verticalEdits } from "@marz/format";
import { CameraShapeRow } from "../camera/CameraShapeRow";
import { SwitchBlock } from "../camera/SwitchBlock";
import { FrameInspector, frameLabels, VerticalBlock } from "../vertical/VerticalPanels";

// design-check-ignore: HTMLElement.blur() drops keyboard focus; it is not a visual blur
const leaveField = (el: HTMLInputElement) => el.blur();

/** One 68px cell: small label, big display value. The value is editable; Enter or leaving the field commits it. */
export function Cell(props: { label: string; text: string; onCommit: (us: number) => void }) {
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
          const us = editedTimeUs(e.currentTarget.value, props.text);
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
  ai: { text: "AI", cls: "badge-ai" },
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
        <span className="badges">
          {cut.origin === "ai" && <span className="badge badge-ai">AI</span>}
          <span className="badge badge-cut">Removed</span>
        </span>
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
      {cut.origin === "ai" && (
        <p className="insp-note">Cut by AI: {cutCapLabel(cut)}. Delete it and the next AI pass leaves this part alone.</p>
      )}
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

export function Toggle(props: { label: string; on: boolean; onChange?: (on: boolean) => void; compact?: boolean }) {
  const disabled = !props.onChange;
  return (
    <div className={`irow${disabled ? " off" : ""}${props.compact ? " k34" : ""}`}>
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

const CORNER_NAMES: Record<Corner, string> = {
  topLeft: "Top left",
  topRight: "Top right",
  bottomLeft: "Bottom left",
  bottomRight: "Bottom right",
};

/** Camera block of the Project panel: show, mirror, corner and size of the picture-in-picture. */
function CameraBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const cam = cameraEdits(project);
  const border = cameraBorder(project);
  return (
    <div className="insp-cam">
      <div className="mut insp-sec">Camera</div>
      <Toggle label="Show camera" on={cam.visible} onChange={(visible) => apply(updateCamera({ visible }))} />
      <Toggle label="Mirror" on={cam.mirror} onChange={(mirror) => apply(updateCamera({ mirror }))} />
      <div className="irow">
        <span>Corner</span>
        <span className="corners" role="radiogroup" aria-label="Camera corner">
          {PIP_CORNERS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={cam.pip.corner === c}
              aria-label={CORNER_NAMES[c]}
              data-tip={CORNER_NAMES[c]}
              className={cam.pip.corner === c ? "on" : ""}
              onClick={() => apply(updateCamera({ pip: { corner: c } }))}
            />
          ))}
        </span>
      </div>
      <div className="irow">
        <span>Size</span>
        <span className="seg" role="radiogroup" aria-label="Camera size">
          {(Object.entries(PIP_SIZES) as [string, number][]).map(([label, frac]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={cam.pip.widthFrac === frac}
              className={cam.pip.widthFrac === frac ? "on" : ""}
              onClick={() => apply(updateCamera({ pip: { widthFrac: frac } }))}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <CameraShapeRow project={project} />
      <Segmented label="Border" options={BORDERS} value={BORDERS.find(([w]) => w === border.width)?.[0] ?? -1}
        onPick={(width) => apply(updateCamera({ border: { width } }))} />
      {border.width > 0 && (
        <div className="irow">
          <span>Colour</span>
          <span className="swatches" role="radiogroup" aria-label="Border colour">
            {BORDER_COLOR_NAMES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={border.color === c}
                aria-label={COLOR_NAMES[c]}
                data-tip={COLOR_NAMES[c]}
                className={`sw-${c}${border.color === c ? " on" : ""}`}
                onClick={() => apply(updateCamera({ border: { color: c } }))}
              />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** Border widths in pixels at 1080 output height. */
const BORDERS: Array<[number, string]> = [
  [0, "None"],
  [1, "Thin"],
  [4, "Thick"],
];
const COLOR_NAMES: Record<BorderColor, string> = { paper: "Paper", ink: "Ink", accent: "Accent" };

/** A row with the Motion row's segmented control. */
export function Segmented<T extends string | number>(props: { label: string; options: Array<[T, string]>; value: T; onPick: (v: T) => void; aria?: string; disabled?: boolean }) {
  return (
    <div className={`irow${props.disabled ? " off" : ""}`}>
      <span>{props.label}</span>
      <span className={props.options.length > 3 ? "seg seg-4" : "seg"} role="radiogroup" aria-label={props.aria ?? `Camera ${props.label.toLowerCase()}`}>
        {props.options.map(([v, text]) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={props.value === v}
            disabled={props.disabled}
            className={props.value === v ? "on" : ""}
            onClick={() => props.value !== v && props.onPick(v)}
          >
            {text}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Layout selected: start, end, which layout, delete. */
function LayoutInspector({ scene, durationUs }: { scene: Scene; durationUs: number }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Pick<Scene, "startUs" | "endUs" | "layout">>) => apply(updateScene(scene.id, p));
  const live = scene.origin === "live";
  return (
    <div className="insp-scroll">
      <div className="insp-head">
        <h2 className="insp-title">Layout</h2>
        <span className={`badge ${live ? "badge-live" : "badge-manual"}`}>{live ? "Live" : "Manual"}</span>
      </div>
      <div className="cells">
        <Cell label="Start" text={mmsst(scene.startUs)}
          onCommit={(us) => patch({ startUs: Math.max(0, Math.min(us, scene.endUs - MIN_US)) })} />
        <Cell label="End" text={mmsst(scene.endUs)}
          onCommit={(us) => patch({ endUs: Math.min(durationUs, Math.max(us, scene.startUs + MIN_US)) })} />
      </div>
      <div className="lay-row">
        <span>Layout</span>
        <span className="ce-grid3" role="radiogroup" aria-label="Layout">
          {LAYOUT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={scene.layout === k}
              className={scene.layout === k ? "on" : ""}
              onClick={() => scene.layout !== k && patch({ layout: k })}
            >
              {LAYOUT_LABEL[k]}
            </button>
          ))}
        </span>
      </div>
      <div className="irow irow-last">
        <span className="mut">Length</span>
        <span>{seconds1(scene.endUs - scene.startUs)}</span>
      </div>
      <p className="insp-note">Between layouts the camera sits in its corner.</p>
      <SwitchBlock scene={scene} />
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete layout
        </button>
      </div>
    </div>
  );
}

const STROKE_COLOR_NAMES: Record<StrokeColor, string> = { accent: "Accent", rec: "Red", paper: "Paper", ink: "Ink" };

/** Drawing stroke selected: start, end, colour, width (size for text), text, delete. */
function DrawingInspector({ stroke, project }: { stroke: Stroke; project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: StrokePatch) => apply(updateStroke(stroke.id, p));
  const widths = strokeWidths(project.source.height);
  const text = stroke.tool === "text";
  const sizes: Array<[number, string]> = text
    ? [[widths.thin, "S"], [widths.medium, "M"], [widths.thick, "L"]]
    : [[widths.thin, "Thin"], [widths.medium, "Medium"], [widths.thick, "Thick"]];
  return (
    <div className="insp-scroll">
      <div className="insp-head">
        <h2 className="insp-title">Drawing</h2>
        <span className={`badge ${stroke.origin === "live" ? "badge-live" : "badge-manual"}`}>{stroke.origin === "live" ? "Live" : "Manual"}</span>
      </div>
      <div className="mut insp-sub">{STROKE_LABEL[stroke.tool]}</div>
      <div className="cells">
        <Cell label="Start" text={mmsst(stroke.startUs)} onCommit={(us) => patch({ startUs: Math.max(0, Math.min(us, stroke.endUs - MIN_US)) })} />
        <Cell label="End" text={mmsst(stroke.endUs)} onCommit={(us) => patch({ endUs: Math.min(project.durationUs, Math.max(us, stroke.startUs + MIN_US)) })} />
      </div>
      {text && (
        <label className="cell cell-wide">
          <span className="k">Text</span>
          <input
            key={`${stroke.id}|${stroke.text}`}
            className="word-input"
            type="text"
            spellCheck={false}
            defaultValue={stroke.text}
            aria-label="Drawing text"
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (!v) e.currentTarget.value = stroke.text ?? "";
              else if (v !== stroke.text) patch({ text: v });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") leaveField(e.currentTarget);
              if (e.key === "Escape") {
                e.currentTarget.value = stroke.text ?? "";
                leaveField(e.currentTarget);
              }
            }}
          />
        </label>
      )}
      <div className="irow">
        <span>Colour</span>
        <span className="swatches" role="radiogroup" aria-label="Drawing colour">
          {STROKE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={stroke.color === c}
              aria-label={STROKE_COLOR_NAMES[c]}
              data-tip={STROKE_COLOR_NAMES[c]}
              className={`sw-${c}${stroke.color === c ? " on" : ""}`}
              onClick={() => stroke.color !== c && patch({ color: c })}
            />
          ))}
        </span>
      </div>
      <div className="irow">
        <span>{text ? "Size" : "Width"}</span>
        <span className="seg" role="radiogroup" aria-label={text ? "Text size" : "Line width"}>
          {sizes.map(([w, label]) => (
            <button key={label} type="button" role="radio" aria-checked={stroke.width === w} className={stroke.width === w ? "on" : ""}
              onClick={() => stroke.width !== w && patch({ width: w })}>
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className="irow irow-last">
        <span className="mut">Length</span>
        <span>{seconds1(stroke.endUs - stroke.startUs)}</span>
      </div>
      <p className="insp-note">Drawn live. Drag it on the preview to move it, pull a corner to resize.</p>
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete drawing
        </button>
      </div>
    </div>
  );
}

type KindKey = "silences" | "fillers" | "mistakes" | "zooms" | "captions";
const KINDS: Array<[KindKey, string]> = [
  ["silences", "Silences"],
  ["fillers", "Ums"],
  ["mistakes", "Mistakes"],
  ["zooms", "AI zooms"],
  ["captions", "Captions"],
];

/** AI edit block of the Project panel: pace slider, kind toggles, last run. */
function AiBlock({ project }: { project: Project }) {
  const ai = aiEdits(project);
  const run = ai.lastRun;
  const [shown, setShown] = useState(ai.paceUs);
  useEffect(() => setShown(ai.paceUs), [ai.paceUs]);
  const langs = run?.languages.length ? run.languages.join(", ") : "no speech";
  return (
    <div className="insp-ai">
      <div className="mut insp-sec">AI edit</div>
      <div className="irow">
        <span>Pace</span>
        <span className="pace">
          Tight
          <input
            key={ai.paceUs}
            type="range"
            min={80}
            max={600}
            step={10}
            defaultValue={Math.round(ai.paceUs / 1000)}
            aria-label="Pace"
            onChange={(e) => setShown(Number(e.currentTarget.value) * 1000)}
            // One drag (or one key press) is one undo step: apply on release.
            onPointerUp={(e) => setPace(Number(e.currentTarget.value) * 1000)}
            onKeyUp={(e) => setPace(Number(e.currentTarget.value) * 1000)}
          />
          Loose
        </span>
        <span className="pace-val">{(shown / 1e6).toFixed(shown % 100_000 === 0 ? 1 : 2)} s</span>
      </div>
      {KINDS.map(([k, label]) => (
        <div key={k} className="k34-wrap">
          <Toggle label={label} on={ai.kinds[k]} onChange={(on) => setKind(k, on)} compact />
        </div>
      ))}
      <div className="insp-last">
        {run ? `Last run: ${langs}. ${run.provider === "claude-code" ? `Claude ${run.model}` : run.provider === "none" ? "No AI step" : run.model}.` : "Not run yet. Press Shift+E to edit with AI."}
      </div>
    </div>
  );
}

/** A caption word: fix its text or hide it from captions (DESIGN-SYSTEM.md "Inspector"). */
function WordInspector({ word, project }: { word: Word; project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const caps = captionEdits(project);
  const text = caps.overrides[word.id] ?? word.text;
  const fixed = caps.overrides[word.id] !== undefined && caps.overrides[word.id] !== word.text;
  const st = wordCaptionState(useCaptionFacts(), word.id);
  return (
    <>
      <h2 className="insp-title">Caption</h2>
      <div className="mut insp-sub">{mmsst(word.startUs)}</div>
      <label className="cell cell-wide">
        <span className="k">Text</span>
        <input
          key={`${word.id}|${text}`}
          className="word-input"
          type="text"
          spellCheck={false}
          defaultValue={text}
          aria-label="Caption text"
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (!v) e.currentTarget.value = text;
            else apply(setCaptionText(word.id, v === word.text ? null : v));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") leaveField(e.currentTarget);
            if (e.key === "Escape") {
              e.currentTarget.value = text;
              leaveField(e.currentTarget);
            }
          }}
        />
      </label>
      <div className="toggles">
        <Toggle label="Hide from captions" on={caps.hidden.includes(word.id)} onChange={(on) => apply(setCaptionHidden(word.id, on))} />
      </div>
      {(fixed || st.shown) && (
        <div className="btns">
          {fixed && (
            <button type="button" className="fb fb-line" onClick={() => apply(setCaptionText(word.id, null))}>
              Use the spoken word
            </button>
          )}
          {st.shown && !st.start && (
            <button type="button" className="fb fb-line" data-tip="Start a new caption at this word / S" onClick={() => setCaptionStartAt(word.id, true)}>
              <Icon name="split" size={14} />
              Split here
              <span className="fb-key">S</span>
            </button>
          )}
          {st.shown && st.start && !st.first && (
            <button type="button" className="fb fb-line" data-tip="Glue this caption onto the one before / J" onClick={() => setCaptionStartAt(word.id, false)}>
              <Icon name="join" size={14} />
              Join with previous
              <span className="fb-key">J</span>
            </button>
          )}
        </div>
      )}
      <p className="insp-note">Fixes the caption only. The audio and the transcript stay as they are.</p>
    </>
  );
}

export function Inspector({ compact = false }: { compact?: boolean }) {
  const project = useEditorStore((s) => s.project)!;
  const selection = useEditorStore((s) => s.selection);
  const apply = useEditorStore((s) => s.apply);

  const zoom = selection?.kind === "zoom" ? project.edits.zooms.find((z) => z.id === selection.id) : undefined;
  const cut = selection?.kind === "cut" ? project.edits.cuts.find((c) => c.id === selection.id) : undefined;
  const words = useEditorStore((s) => s.words);
  const word = selection?.kind === "word" ? words.find((w) => w.id === selection.id) : undefined;
  const scene = selection?.kind === "layout" ? cameraScenes(project).find((x) => x.id === selection.id) : undefined;
  const holds = verticalEdits(project).holds;
  const hold = selection?.kind === "frame" ? holds.find((h) => h.id === selection.id) : undefined;
  const stroke = selection?.kind === "drawing" ? drawingStrokes(project).find((x) => x.id === selection.id) : undefined;
  const curSec = selection?.kind === "cursor" ? cursorSections(project).find((x) => x.id === selection.id) : undefined;
  const tab = useEditorStore((s) => s.inspectorTab);
  const setTab = useEditorStore((s) => s.setInspectorTab);
  const checklist = hasChecklist(project);
  const tabs = words.length > 0 || checklist;

  const edit = zoom ? (
        <ZoomInspector zoom={zoom} title={zoomLabels(project.edits.zooms).get(zoom.id) ?? "Zoom"} durationUs={project.durationUs} />
      ) : cut ? (
        <CutInspector cut={cut} durationUs={project.durationUs} />
      ) : scene ? (
        <LayoutInspector scene={scene} durationUs={project.durationUs} />
      ) : hold ? (
        <FrameInspector hold={hold} title={frameLabels(holds).get(hold.id) ?? "Frame"} durationUs={project.durationUs} />
      ) : stroke ? (
        <DrawingInspector stroke={stroke} project={project} />
      ) : curSec ? (
        <CursorInspector section={curSec} durationUs={project.durationUs} baked={cursorKind(project) === "baked"} />
      ) : word ? (
        <WordInspector word={word} project={project} />
      ) : (
        <div className="insp-scroll">
          <h2 className="insp-title">Project</h2>
          <div className="mut insp-sub">{selection?.kind === "camera" ? "Camera bubble selected" : "Nothing selected"}</div>
          <LookBlock project={project} />
          <CursorBlock project={project} />
          {project.tracks.camera && <CameraBlock project={project} />}
          <VerticalBlock project={project} />
          <BackgroundBlock project={project} />
          <AudioBlock project={project} />
          {words.length > 0 && <CaptionsBlock project={project} />}
          <AiBlock project={project} />
          {!compact && <p className="insp-note">Select a zoom or a cut on the timeline to edit it.</p>}
        </div>
      );

  // A tab whose content is gone (no transcript, no checklist) shows Edit.
  const shown = (tab === "transcript" && words.length === 0) || (tab === "checklist" && !checklist) ? "edit" : tab;
  if (!tabs)
    return (
      <aside className="insp on-paper" aria-label="Inspector">
        {edit}
      </aside>
    );
  return (
    <aside className="insp insp-tabbed on-paper" aria-label="Inspector">
      {/* Edit and Transcript tabs (DESIGN-SYSTEM.md Inspector, "Tabs"). */}
      <div className={`insp-tabs${words.length > 0 && checklist ? " three" : ""}`} role="tablist" aria-label="Inspector view">
        {(
          [
            ["edit", "Edit", "cursor", words.length > 0 ? "T" : "K", true],
            ["transcript", "Transcript", "captions", "T", words.length > 0],
            ["checklist", "Checklist", "list", "K", checklist],
          ] as const
        )
          .filter((t) => t[4])
          .map(([id, label, icon, key]) => (
            <button key={id} type="button" role="tab" aria-selected={shown === id} className={shown === id ? "on" : ""} data-tip={`${label} / ${key}`} onClick={() => setTab(id)}>
              <Icon name={icon} size={14} />
              {label}
              <span className="tab-key">{key}</span>
            </button>
          ))}
      </div>
      <div className="insp-body">{shown === "transcript" ? <TranscriptPanel /> : shown === "checklist" ? <ChecklistPanel /> : edit}</div>
    </aside>
  );
}
