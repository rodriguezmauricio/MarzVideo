import { AudioBlock } from "./AudioBlock";
import { useEffect, useState } from "react";
import { aiEdits, BORDER_COLOR_NAMES, cameraBorder, cameraEdits, cameraScenes, captionEdits, LAYOUT_KINDS, PIP_CORNERS, PIP_SIZES, type BorderColor, type Corner, type Cut, type PipShape, type Project, type Scene, type Word, type Zoom } from "@marz/format";
import { setCaptionHidden, setCaptionText, setCursorHidden, updateCamera, updateCut, updateScene, updateZoom } from "@marz/timeline";
import { setKind, setPace } from "../ai/aiActions";
import { deleteSelection, MIN_US } from "../state/actions";
import { useEditorStore } from "../state/editorStore";
import { Icon } from "./Icon";
import { mmsst, parseTimeUs, seconds1 } from "./timecode";
import { cutCapLabel, LAYOUT_LABEL, zoomLabels } from "./zoomLabels";

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
      <Segmented label="Shape" options={SHAPES} value={(PIP_SHAPE_SET.has(cam.pip.shape) ? cam.pip.shape : "rect") as PipShape}
        onPick={(shape) => apply(updateCamera({ pip: { shape } }))} />
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

const SHAPES: Array<[PipShape, string]> = [
  ["rect", "Plain"],
  // design-check-ignore: the camera mask name (video content), not a UI radius
  ["rounded", "Round"],
  ["circle", "Circle"],
  ["square", "Square"],
];
const PIP_SHAPE_SET = new Set<string>(SHAPES.map(([v]) => v));
/** Border widths in pixels at 1080 output height. */
const BORDERS: Array<[number, string]> = [
  [0, "None"],
  [1, "Thin"],
  [4, "Thick"],
];
const COLOR_NAMES: Record<BorderColor, string> = { paper: "Paper", ink: "Ink", accent: "Accent" };

/** A row with the Motion row's segmented control. */
function Segmented<T extends string | number>(props: { label: string; options: Array<[T, string]>; value: T; onPick: (v: T) => void }) {
  return (
    <div className="irow">
      <span>{props.label}</span>
      <span className={props.options.length > 3 ? "seg seg-4" : "seg"} role="radiogroup" aria-label={`Camera ${props.label.toLowerCase()}`}>
        {props.options.map(([v, text]) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={props.value === v}
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
        <span className="lay-grid" role="radiogroup" aria-label="Layout">
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
      <p className="insp-note">Between layouts the camera sits in its corner. Switches take 0.4 s.</p>
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={deleteSelection}>
          <Icon name="trash" size={14} />
          Delete layout
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
      {fixed && (
        <div className="btns">
          <button type="button" className="fb fb-line" onClick={() => apply(setCaptionText(word.id, null))}>
            Use the spoken word
          </button>
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

  return (
    <aside className="insp on-paper" aria-label="Inspector">
      {zoom ? (
        <ZoomInspector zoom={zoom} title={zoomLabels(project.edits.zooms).get(zoom.id) ?? "Zoom"} durationUs={project.durationUs} />
      ) : cut ? (
        <CutInspector cut={cut} durationUs={project.durationUs} />
      ) : scene ? (
        <LayoutInspector scene={scene} durationUs={project.durationUs} />
      ) : word ? (
        <WordInspector word={word} project={project} />
      ) : (
        <div className="insp-scroll">
          <h2 className="insp-title">Project</h2>
          <div className="mut insp-sub">Nothing selected</div>
          <div className="toggles">
            <Toggle label="Hide cursor" on={project.edits.cursor.hidden} onChange={(on) => apply(setCursorHidden(on))} />
            {/* Shows the stored setting; switching click effects is not built yet (see DEVIATIONS.md). */}
            <Toggle label="Click highlight" on={project.edits.clicks.effect !== "none"} />
          </div>
          {project.tracks.camera && <CameraBlock project={project} />}
          <AudioBlock project={project} />
          <AiBlock project={project} />
          {!compact && <p className="insp-note">Select a zoom or a cut on the timeline to edit it.</p>}
        </div>
      )}
    </aside>
  );
}
