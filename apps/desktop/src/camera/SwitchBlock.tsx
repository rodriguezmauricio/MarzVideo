import { transitionFor, type Morph, type Project, type Scene, type TransitionEasing } from "@marz/format";
import { layoutKindAt } from "@marz/compositor";
import { setTransition } from "@marz/timeline";
import { useEditorStore } from "../state/editorStore";
import { Segmented } from "../components/Inspector";
import { LAYOUT_LABEL } from "../components/zoomLabels";
import "./camera-extras.css";

const LENGTHS: Array<[number, string]> = [
  [400_000, "0.4 s"],
  [800_000, "0.8 s"],
  [1_200_000, "1.2 s"],
];
const EASINGS: Array<[TransitionEasing, string]> = [
  ["easeInOutCubic", "Smooth"],
  ["linear", "Linear"],
  ["easeInCubic", "In"],
  ["easeOutCubic", "Out"],
];
const MORPHS: Array<[Morph, string]> = [
  ["blend", "Along"],
  ["end", "At end"],
];

/** The layout before a scene (the bubble when nothing covers the moment before it). A scene at 0 has no switch in: its own layout. */
export const layoutBefore = (project: Project, scene: Scene) => (scene.startUs > 0 ? layoutKindAt(project, scene.startUs - 1) : scene.layout);

/** Layout inspector "Switch in" section: the preset for the switch into this scene's layout. */
export function SwitchBlock({ scene }: { scene: Scene }) {
  const apply = useEditorStore((s) => s.apply);
  const project = useEditorStore((s) => s.project)!;
  const from = layoutBefore(project, scene);
  const to = scene.layout;
  if (from === to) return null;
  const spec = transitionFor(project, from, to);
  return (
    <div className="ce-switch">
      <div className="ce-sec">
        <span className="mut insp-sec">Switch in</span>
        <b>From {LAYOUT_LABEL[from]}</b>
      </div>
      <Segmented label="Length" aria="Switch length" options={LENGTHS} value={LENGTHS.find(([v]) => v === spec.durationUs)?.[0] ?? -1}
        onPick={(durationUs) => apply(setTransition(from, to, { durationUs }))} />
      <Segmented label="Easing" aria="Switch easing" options={EASINGS} value={spec.easing}
        onPick={(easing) => apply(setTransition(from, to, { easing }))} />
      <Segmented label="Morph" aria="Shape morph" options={MORPHS} value={spec.morph}
        onPick={(morph) => apply(setTransition(from, to, { morph }))} />
      <div className="btns">
        <button type="button" className="fb fb-line" disabled={!spec.path} onClick={() => apply(setTransition(from, to, { path: null }))}>
          Straight path
        </button>
      </div>
      <p className="ce-note">
        Every switch from {LAYOUT_LABEL[from]} to {LAYOUT_LABEL[to]} uses this, live ones too. Drag the squares on the preview to bend the path.
      </p>
    </div>
  );
}
