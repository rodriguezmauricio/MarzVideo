import { useEffect, useRef } from "react";
import { keptSegments, setVertical } from "@marz/timeline";
import { verticalEdits } from "@marz/format";
import { Icon } from "../components/Icon";
import { useEditorStore } from "../state/editorStore";
import { useExportStore } from "./exportStore";
import { folderName, hevcNote, presetSize, PRESET_ORDER } from "./exportUi";
import { hevcKey } from "./encoderConfig";
import type { ExportPreset } from "./presets";
import { CODEC_LABEL, CODEC_OPTIONS, FPS_OPTIONS, SIZE_OPTIONS, fpsAllowed, resolvePreset, withCodec } from "./choices";
import { isTauri } from "../platform";
import { refuseEmpty } from "./outputFrames";

const ICON = { youtube: "fullscreen", vertical: "portrait" } as const;

/** Export MP4 in the top strip (DESIGN-SYSTEM.md "Export"): the button and its preset panel, or
 *  "Exporting 42%" with Cancel while an export runs. */
export function ExportControl() {
  const project = useEditorStore((s) => s.project)!;
  const phase = useExportStore((s) => s.phase);
  const progress = useExportStore((s) => s.progress);
  const panel = useExportStore((s) => s.panel);
  const burn = useExportStore((s) => s.burn);
  const toggleBurn = useExportStore((s) => s.toggleBurn);
  const hasWords = useEditorStore((s) => s.words.length > 0);
  const last = useExportStore((s) => s.last);
  const choices = useExportStore((s) => s.choices);
  const hevc = useExportStore((s) => s.hevc);
  const copyTo = useExportStore((s) => s.copyTo);
  const hevcAt = useExportStore((s) => s.hevcAt);
  // Each row as it will export: H.264 where HEVC cannot be used at that size and rate.
  const planned = (p: ExportPreset) => {
    const r = resolvePreset(p, choices[p.id], project.source.fps);
    if (r.codec !== "hevc") return r;
    const fps = r.fps(project.source.fps);
    return hevc === "no" || hevcAt[hevcKey(r, fps)] === false ? withCodec(r, "h264") : r;
  };
  useEffect(() => {
    if (!panel.open) return;
    for (const p of PRESET_ORDER) {
      const r = resolvePreset(p, choices[p.id], project.source.fps);
      if (r.codec === "hevc") useExportStore.getState().probeHevc(r, r.fps(project.source.fps));
    }
  }, [panel.open, choices, project.source.fps]);
  const { togglePanel, closePanel, highlight, start, cancel, setChoice, pickCopyTo, clearCopyTo } = useExportStore.getState();
  const wrap = useRef<HTMLDivElement>(null);
  const empty = refuseEmpty(keptSegments(project.durationUs, project.edits.cuts));
  const follow = verticalEdits(project).framing === "follow";

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
              <span className="xsize">{presetSize(planned(p), project.source.fps)}</span>
              <i className={last === p.id ? "mark" : undefined} />
            </button>
          ))}
          <ExportChoiceRows id={panel.highlight} sourceFps={project.source.fps} choices={choices[panel.highlight]} hevc={hevc} hevcAt={hevcAt} onChoice={(patch) => setChoice(panel.highlight, patch)} />
          {panel.highlight === "vertical" && (
            // Smart vertical: Follow the action (default) or Fit with bars; the Vertical block's Framing.
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={follow}
              className="ep-burn"
              onClick={() => useEditorStore.getState().apply(setVertical({ framing: follow ? "fit" : "follow" }))}
            >
              <span className="lbl">
                <Icon name="portrait" size={15} />
                Follow the action
              </span>
              <span className={`tg${follow ? " on" : ""}`} aria-hidden="true">
                <i />
              </span>
            </button>
          )}
          {hasWords && (
            <button type="button" role="menuitemcheckbox" aria-checked={burn[panel.highlight]} className="ep-burn" onClick={() => toggleBurn(panel.highlight)}>
              <span className="lbl">
                <Icon name="captions" size={15} />
                Burn captions
              </span>
              <span className={`tg${burn[panel.highlight] ? " on" : ""}`} aria-hidden="true">
                <i />
              </span>
            </button>
          )}
          {isTauri() && (
            // Also copy to: the MarzOS drop folder, remembered by the app.
            <div className="ep-burn ep-copy">
              <button type="button" role="menuitem" className="ep-copy-pick" onClick={() => void pickCopyTo()}>
                <span className="lbl">
                  <Icon name="folder" size={15} />
                  Also copy to
                </span>
                <span className="ep-dir">{copyTo ? folderName(copyTo) : "Off"}</span>
              </button>
              {copyTo && (
                <button type="button" className="ep-x tip-left" aria-label="Stop copying exports" data-tip="Stop copying exports" onClick={() => void clearCopyTo()}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Choices = ReturnType<typeof useExportStore.getState>["choices"]["youtube"];

/** Codec, Size (YouTube only) and Frame rate rows for the highlighted preset (DESIGN-SYSTEM.md "Export choices"). */
function ExportChoiceRows(props: {
  id: "youtube" | "vertical";
  sourceFps: number;
  choices: Choices;
  hevc: "unknown" | "yes" | "no";
  hevcAt: Record<string, boolean>;
  onChoice: (patch: Partial<Choices>) => void;
}) {
  const { id, sourceFps, choices, hevc, hevcAt, onChoice } = props;
  const used = resolvePreset({ ...PRESET_ORDER.find((p) => p.id === id)! }, choices, sourceFps);
  const fpsNow = used.fps(sourceFps);
  const noHevc = hevc === "no";
  return (
    <>
      <div className="ep-burn ep-choice">
        <span className="lbl">
          <Icon name="layers" size={15} />
          Codec
        </span>
        <span className="seg" role="group" aria-label="Codec">
          {CODEC_OPTIONS.map((c) => {
            const off = c === "hevc" && noHevc;
            return (
              <button
                key={c}
                type="button"
                className={`${choices.codec === c && !off ? "on" : ""}${off ? " off tip-left" : ""}`}
                aria-pressed={choices.codec === c && !off}
                aria-disabled={off || undefined}
                data-tip={off ? "HEVC is not available on this computer" : undefined}
                onClick={() => !off && onChoice({ codec: c })}
              >
                {CODEC_LABEL[c]}
              </button>
            );
          })}
        </span>
      </div>
      {(() => {
        const note = hevcNote(hevc, choices.codec === "hevc" ? hevcAt[hevcKey(used, fpsNow)] : undefined);
        return note && <p className="ep-note">{note}</p>;
      })()}
      {id === "youtube" && (
        <div className="ep-burn ep-choice">
          <span className="lbl">
            <Icon name="fullscreen" size={15} />
            Size
          </span>
          <span className="seg" role="group" aria-label="Size">
            {SIZE_OPTIONS.map((z) => (
              <button key={z} type="button" className={choices.size === z ? "on" : ""} aria-pressed={choices.size === z} onClick={() => onChoice({ size: z })}>
                {z}
              </button>
            ))}
          </span>
        </div>
      )}
      <div className="ep-burn ep-choice">
        <span className="lbl">
          <Icon name="play" size={15} />
          Frame rate
        </span>
        <span className="seg" role="group" aria-label="Frame rate">
          {FPS_OPTIONS.map((f) => {
            const off = !fpsAllowed(f, sourceFps);
            return (
              <button
                key={f}
                type="button"
                className={`${fpsNow === f ? "on" : ""}${off ? " off tip-left" : ""}`}
                aria-pressed={fpsNow === f}
                aria-disabled={off || undefined}
                data-tip={off ? `The recording is ${Math.round(sourceFps)} fps` : undefined}
                onClick={() => !off && onChoice({ fps: f })}
              >
                {f}
              </button>
            );
          })}
        </span>
      </div>
    </>
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
  const lead = useExportStore((s) => s.doneLead);
  const note = useExportStore((s) => s.doneNote);
  if (phase !== "done" || doneFor !== project) return null;
  return (
    <span data-testid="export-done" className="save">
      <i />
      {lead}
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
      {note}
    </span>
  );
}
