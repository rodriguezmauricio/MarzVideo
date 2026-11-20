// Scene presets ("looks"): the camera, background and caption style of a project under a name
// (design docs/superpowers/specs/2026-11-19-scene-presets-design.md). Looks live outside the
// project; applying one writes the ordinary `edits.*` fields.
import { cameraEdits, rawBackground, type Project } from "@marz/format";
import type { Command } from "./commands";

type Obj = Record<string, unknown>;

/** The camera part of a look: everything but `visible`, `scenes` and `liveImported`. */
export type LookCamera = {
  mirror: boolean;
  pip: Obj;
  border?: Obj;
  customMask?: unknown;
  transitions?: unknown[];
};

/** One saved look. Unknown keys from a later build are kept by the file code. */
export type Look = {
  name: string;
  savedAt: string;
  /** Missing: the look leaves the camera alone (saved from a take without a camera). */
  camera?: LookCamera;
  /** The whole `edits.background` (opaque). `null`: no background, the screen fills the video. */
  background: Obj | null;
  /** The whole `edits.captions.styles`. `{}`: both presets at their defaults. */
  captionStyles: Obj;
  [k: string]: unknown;
};

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function rawCaptionStyles(p: Project): Obj {
  const s = p.edits.captions?.styles;
  return isObj(s) ? s : {};
}

/** The look of `p` under `name`. The camera part only when the take has a camera. */
export function lookOf(p: Project, name: string, now: Date = new Date()): Look {
  const look: Look = {
    name,
    savedAt: now.toISOString(),
    background: (p.edits as Obj).background === undefined ? null : clone(rawBackground(p)),
    captionStyles: clone(rawCaptionStyles(p)),
  };
  if (p.tracks.camera) {
    const c = cameraEdits(p);
    const cam: LookCamera = { mirror: c.mirror, pip: clone(c.pip as Obj) };
    if (c.border !== undefined) cam.border = clone(c.border as Obj);
    if (c.customMask !== undefined) cam.customMask = clone(c.customMask);
    if (c.transitions !== undefined) cam.transitions = clone(c.transitions as unknown[]);
    look.camera = cam;
  }
  return look;
}

/** Apply a look as one undo step. Keeps the target's camera visibility, layout scenes and fields this
 * build does not know; copies the background and caption styles whole. Returns `p` when nothing changes. */
export const applyLook =
  (look: Look): Command =>
  (p) => {
    const edits: Obj = { ...p.edits };

    if (look.camera) {
      const cur = cameraEdits(p) as Obj;
      const { border: _b, customMask: _m, transitions: _t, ...kept } = cur;
      const cam: Obj = { ...kept, mirror: look.camera.mirror, pip: clone(look.camera.pip) };
      if (look.camera.border !== undefined) cam.border = clone(look.camera.border);
      if (look.camera.customMask !== undefined) cam.customMask = clone(look.camera.customMask);
      if (look.camera.transitions !== undefined) cam.transitions = clone(look.camera.transitions);
      edits.camera = cam;
    }

    if (look.background === null) delete edits.background;
    else edits.background = clone(look.background);

    const captions = p.edits.captions;
    const styles = clone(look.captionStyles ?? {});
    if (captions) edits.captions = { ...captions, styles };
    else if (Object.keys(styles).length > 0) edits.captions = { overrides: {}, hidden: [], styles };

    const next = { ...p, edits: edits as Project["edits"] };
    return sameLook(p, next) ? p : next;
  };

/** Whether two projects have the same look fields (camera, background, caption styles). */
function sameLook(a: Project, b: Project): boolean {
  const pick = (p: Project) =>
    JSON.stringify([(p.edits as Obj).camera ?? null, (p.edits as Obj).background ?? null, rawCaptionStyles(p)]);
  return pick(a) === pick(b);
}

/** A take nobody styled yet: no camera, background or caption style edits (the recorder writes none). */
export function isFreshTake(p: Project): boolean {
  const e = p.edits as Obj;
  return e.camera === undefined && e.background === undefined && Object.keys(rawCaptionStyles(p)).length === 0;
}
