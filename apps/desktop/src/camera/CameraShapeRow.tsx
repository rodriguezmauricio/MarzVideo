import { useRef, useState } from "react";
import { cameraEdits, customMask, type PipShape, type Project } from "@marz/format";
import { parseSvgMask } from "@marz/compositor";
import { setCustomMask, updateCamera } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import "./camera-extras.css";

const SHAPES: Array<[PipShape, string]> = [
  ["rect", "Plain"],
  // design-check-ignore: the camera mask name (video content), not a UI radius
  ["rounded", "Round"],
  ["circle", "Circle"],
  ["square", "Square"],
  ["star", "Star"],
  ["custom", "Custom"],
];
const SHAPE_SET = new Set<string>(SHAPES.map(([v]) => v));
/** Larger SVG files are refused before reading (an outline never needs this much). */
const MAX_SVG_BYTES = 2_000_000;
const ONE_PATH = "Use an SVG with one closed path.";

/** Camera block Shape row: six masks in a 3 x 2 grid; Custom imports one closed outline from an SVG file. */
export function CameraShapeRow({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const cam = cameraEdits(project);
  const mask = customMask(project);
  const shape = (SHAPE_SET.has(cam.pip.shape) ? cam.pip.shape : "rect") as PipShape;
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const pick = (s: PipShape) => {
    setError(null);
    if (s === "custom" && !mask) file.current?.click();
    else if (s !== shape) apply(updateCamera({ pip: { shape: s } }));
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > MAX_SVG_BYTES) return setError(ONE_PATH);
    const r = parseSvgMask(await f.text());
    if (!r.ok) return setError(r.error);
    setError(null);
    apply(setCustomMask({ name: f.name.slice(0, 200), points: r.points }));
  };

  return (
    <>
      <div className="ce-row">
        <span>Shape</span>
        <span className="ce-grid3" role="radiogroup" aria-label="Camera shape">
          {SHAPES.map(([v, text]) => (
            <button key={v} type="button" role="radio" aria-checked={shape === v} className={shape === v ? "on" : ""} onClick={() => pick(v)}>
              {text}
            </button>
          ))}
        </span>
        {error && <p className="ce-err">{error}</p>}
      </div>
      {shape === "custom" && (
        <div className="irow">
          <span>Custom shape</span>
          <span className="ce-file">
            <span title={mask?.name ?? ""}>{mask?.name ?? "None"}</span>
            <button type="button" className="ce-link" onClick={() => file.current?.click()}>
              Import SVG
            </button>
          </span>
        </div>
      )}
      <input ref={file} type="file" accept=".svg,image/svg+xml" hidden data-testid="svg-input" onChange={onFile} />
    </>
  );
}
