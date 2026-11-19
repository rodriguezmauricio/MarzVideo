import { cameraEdits, cameraScenes, type CameraEdits, type LayoutKind, type MarzEvent, type Project, type Scene } from "@marz/format";
import type { Command } from "./commands";

/** Shortest layout scene. */
export const MIN_SCENE_US = 100_000;

/** Write `scenes` into `edits.camera` (defaults filled in), keeping scenes this build cannot read. */
function withScenes(p: Project, scenes: Scene[], extra: Partial<CameraEdits> = {}): Project {
  const cur = cameraEdits(p);
  const unknown = (cur.scenes as unknown[]).filter((s) => !cameraScenes({ ...p, edits: { ...p.edits, camera: { ...cur, scenes: [s] } } }).length);
  const camera: CameraEdits = { ...cur, ...extra, scenes: [...scenes.sort((a, b) => a.startUs - b.startUs), ...unknown] };
  return { ...p, edits: { ...p.edits, camera } };
}

/** Add a layout scene in the free time after its start: a start inside another scene moves to that
 *  scene's end, the end stops at the next scene or the end of the video. No room: `p` unchanged. */
export const addScene =
  (s: Scene): Command =>
  (p) => {
    const list = cameraScenes(p);
    const D = p.durationUs;
    let start = Math.max(0, Math.min(s.startUs, D));
    for (const x of list) if (x.startUs <= start && start < x.endUs) start = x.endUs;
    const next = list.filter((x) => x.startUs >= start).reduce((m, x) => Math.min(m, x.startUs), D);
    const end = Math.min(s.endUs, D, next);
    if (end - start < MIN_SCENE_US) return p;
    return withScenes(p, [...list, { ...s, startUs: start, endUs: end }]);
  };

/** Change a scene's time or layout, kept between its neighbours and at least `MIN_SCENE_US` long. A
 *  live scene becomes the user's own when its time changes. Returns `p` when nothing changes. */
export const updateScene =
  (id: string, patch: Partial<Pick<Scene, "startUs" | "endUs" | "layout">>): Command =>
  (p) => {
    const list = cameraScenes(p);
    const cur = list.find((x) => x.id === id);
    if (!cur) return p;
    const others = list.filter((x) => x.id !== id);
    const prevEnd = others.filter((x) => x.startUs < cur.startUs).reduce((m, x) => Math.max(m, x.endUs), 0);
    const nextStart = others.filter((x) => x.startUs >= cur.startUs).reduce((m, x) => Math.min(m, x.startUs), p.durationUs);
    const len = cur.endUs - cur.startUs;
    // A move (both ends, same length) keeps its length and stops at the neighbours.
    const isMove = patch.startUs !== undefined && patch.endUs !== undefined && patch.endUs - patch.startUs === len;
    const startUs = isMove
      ? Math.max(prevEnd, Math.min(patch.startUs!, nextStart - len))
      : Math.max(prevEnd, Math.min(patch.startUs ?? cur.startUs, nextStart - MIN_SCENE_US));
    const endUs = isMove ? startUs + len : Math.min(nextStart, Math.max(patch.endUs ?? cur.endUs, startUs + MIN_SCENE_US));
    const layout = patch.layout ?? cur.layout;
    if (startUs === cur.startUs && endUs === cur.endUs && layout === cur.layout) return p;
    const moved = startUs !== cur.startUs || endUs !== cur.endUs;
    const origin = moved && cur.origin === "live" ? "manual" : cur.origin;
    return withScenes(p, [...others, { ...cur, startUs, endUs, layout, origin }]);
  };

export const removeScene =
  (id: string): Command =>
  (p) => {
    const list = cameraScenes(p);
    if (!list.some((x) => x.id === id)) return p;
    return withScenes(p, list.filter((x) => x.id !== id));
  };

/** Turn the live layout presses of `events.jsonl` into scenes, once per project (`liveImported`).
 *  Each press starts a scene that ends at the next press or the end of the video; a press of the
 *  corner bubble (the default) only ends the previous one; a repeat of the current layout is
 *  ignored. Returns `p` when there is nothing to import. */
export const importLiveLayouts =
  (events: MarzEvent[]): Command =>
  (p) => {
    if (!p.tracks.camera || cameraEdits(p).liveImported) return p;
    const D = p.durationUs;
    const presses = events
      .filter((e): e is Extract<MarzEvent, { type: "layout" }> => e.type === "layout" && e.tUs >= 0 && e.tUs < D)
      .sort((a, b) => a.tUs - b.tUs);
    const kept: { tUs: number; layout: LayoutKind }[] = [];
    for (const e of presses) if ((kept[kept.length - 1]?.layout ?? "pip") !== e.layout) kept.push(e);
    if (kept.length === 0) return p;
    const scenes: Scene[] = [];
    kept.forEach((e, i) => {
      if (e.layout === "pip") return;
      const endUs = kept[i + 1]?.tUs ?? D;
      if (endUs - e.tUs < MIN_SCENE_US) return;
      scenes.push({ id: `live-layout-${scenes.length + 1}`, startUs: e.tUs, endUs, layout: e.layout, origin: "live" });
    });
    return withScenes(p, [...cameraScenes(p), ...scenes], { liveImported: true });
  };
