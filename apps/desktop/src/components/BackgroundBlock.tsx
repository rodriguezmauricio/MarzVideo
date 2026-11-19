import { backgroundEdits, type BackgroundCorners, type BackgroundPadding, type BackgroundStyle, type Project } from "@marz/format";
import { setBackground } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { Segmented, Toggle } from "./Inspector";

const STYLES: Array<[BackgroundStyle, string]> = [
  ["off", "Off"],
  ["ink", "Ink"],
  ["paper", "Paper"],
  ["glow", "Glow"],
  ["grid", "Grid"],
];

/** Background block of the Project panel (DESIGN-SYSTEM.md Inspector): backdrop style, margin, corners,
 *  and the frame toggle under them. One background per project; every change is one undo step. */
export function BackgroundBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const b = backgroundEdits(project);
  const on = b.style !== "off";
  return (
    <div className="insp-vert">
      <div className="mut insp-sec">Background</div>
      <Segmented aria="Background style" label="Style" options={STYLES} value={b.style} onPick={(style) => apply(setBackground({ style }))} />
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
      <div className="insp-last">{on ? "The screen sits framed on the background." : "The screen fills the video."}</div>
    </div>
  );
}
