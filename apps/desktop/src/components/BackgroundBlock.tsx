import { useState } from "react";
import { backgroundEdits, type BackgroundCorners, type BackgroundGradient, type BackgroundPadding, type BackgroundStyle, type Project } from "@marz/format";
import { setBackground } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { useBackgroundImage } from "../background/backgroundImage";
import { Segmented, Toggle } from "./Inspector";
import "../camera/camera-extras.css";

const STYLES: Array<[BackgroundStyle, string]> = [
  ["off", "Off"],
  ["ink", "Ink"],
  ["paper", "Paper"],
  ["glow", "Glow"],
  ["grid", "Grid"],
  ["gradient", "Gradient"],
  ["image", "Image"],
  // design-check-ignore: names the video background style, not a UI blur
  ["blur", "Blur"],
];

const GRADIENTS: Array<[BackgroundGradient, string]> = [
  ["ink-accent", "Ink, accent"],
  ["ink-paper", "Ink, paper"],
  ["paper-accent", "Paper, accent"],
];

const NOTE: Partial<Record<BackgroundStyle, string>> = {
  image: "Your image covers the video behind the frame.",
  // design-check-ignore: names the video background style, not a UI blur
  blur: "The screen, blurred, fills the video behind the frame.",
};

/** Background block of the Project panel (DESIGN-SYSTEM.md Inspector): backdrop style (the camera shape grid,
 *  three columns), the gradient pair or the image under it, then margin, corners and the frame toggle. One
 *  background per project; every change is one undo step. */
export function BackgroundBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const storage = useEditorStore((s) => s.storage);
  const b = backgroundEdits(project);
  const on = b.style !== "off";
  const img = useBackgroundImage(project, storage);
  const [error, setError] = useState<string | null>(null);

  const pickImage = async () => {
    if (!storage?.pickBackgroundImage) return setError("Pick an image in the app.");
    try {
      const image = await storage.pickBackgroundImage();
      if (!image) return;
      setError(null);
      apply(setBackground({ style: "image", image }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="insp-vert">
      <div className="mut insp-sec">Background</div>
      <div className="ce-row">
        <span>Style</span>
        <span className="ce-grid3" role="radiogroup" aria-label="Background style">
          {STYLES.map(([v, text]) => (
            <button key={v} type="button" role="radio" aria-checked={b.style === v} className={b.style === v ? "on" : ""} onClick={() => apply(setBackground({ style: v }))}>
              {text}
            </button>
          ))}
        </span>
      </div>
      {b.style === "gradient" && (
        <Segmented<BackgroundGradient> aria="Gradient colours" label="Colours" options={GRADIENTS} value={b.gradient} onPick={(gradient) => apply(setBackground({ gradient }))} />
      )}
      {b.style === "image" && (
        <div className="irow">
          <span>Image</span>
          <span className="ce-file">
            <span title={b.image ?? ""}>{b.image ? b.image.slice(b.image.lastIndexOf("/") + 1) : "None"}</span>
            <button type="button" className="ce-link" onClick={() => void pickImage()}>
              Pick image
            </button>
          </span>
        </div>
      )}
      {b.style === "image" && (error || img.status === "missing") && <p className="ce-err">{error ?? (b.image ? "Image missing. Pick it again." : "No image yet. Pick a JPG or PNG.")}</p>}
      {on && (
        <>
          <Segmented<BackgroundPadding>
            aria="Background margin"
            label="Margin"
            options={[
              ["S", "S"],
              ["M", "M"],
              ["L", "L"],
            ]}
            value={b.padding}
            onPick={(padding) => apply(setBackground({ padding }))}
          />
          <Segmented<BackgroundCorners>
            aria="Frame corners"
            label="Corners"
            options={[
              ["square", "Square"],
              ["round", "Round"],
            ]}
            value={b.corners}
            onPick={(corners) => apply(setBackground({ corners }))}
          />
          {/* design-check-ignore: names the video frame's shadow setting, not a UI shadow */}
          <Toggle label="Shadow" compact on={b.shadow} onChange={(shadow) => apply(setBackground({ shadow }))} />
        </>
      )}
      <div className="insp-last">{on ? (NOTE[b.style] ?? "The screen sits framed on the background.") : "The screen fills the video."}</div>
    </div>
  );
}
