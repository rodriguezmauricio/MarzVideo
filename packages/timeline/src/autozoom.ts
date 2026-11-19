import type { ClickEvent, MarzEvent, Zoom } from "@marz/format";
import { lockAspect } from "./zoom";

export type AutoZoomOptions = {
  clusterGapUs?: number;
  paddingUs?: number;
  zoomScale?: number;
  minGapUs?: number;
  /** The recording's length: a zoom never runs past it. */
  durationUs?: number;
};

/** A cluster that needs a wider rect than this (share of the frame) gives no zoom: it would be
 *  nearly the full frame and only add a jolt. */
const MAX_RECT_W = 0.8;
/** A zoom shorter than this (after clamping to the duration) is dropped. */
const MIN_LEN_US = 500_000;

type Point = { x: number; y: number };
type Group = { startUs: number; endUs: number; points: Point[] };

/** Suggest zooms from clusters of left/right/middle button-down clicks. A lone click is never a cluster. */
export function suggestZooms(
  events: MarzEvent[],
  source: { width: number; height: number },
  outputAspect: number,
  opts: AutoZoomOptions = {},
): Zoom[] {
  const clusterGapUs = opts.clusterGapUs ?? 2_000_000;
  const paddingUs = opts.paddingUs ?? 600_000;
  const zoomScale = opts.zoomScale ?? 0.5;
  const minGapUs = opts.minGapUs ?? 800_000;
  const durationUs = opts.durationUs ?? Infinity;

  const downs = events
    .filter((e): e is ClickEvent => e.type === "click" && e.state === "down")
    .sort((a, b) => a.tUs - b.tUs);

  const clusters: (typeof downs)[] = [];
  for (const c of downs) {
    const cur = clusters[clusters.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && c.tUs - prev.tUs <= clusterGapUs) cur.push(c);
    else clusters.push([c]);
  }

  const groups: Group[] = [];
  for (const cl of clusters) {
    if (cl.length < 2) continue;
    const g: Group = {
      startUs: Math.max(0, cl[0]!.tUs - paddingUs),
      endUs: cl[cl.length - 1]!.tUs + paddingUs,
      points: cl.map((c) => ({ x: c.x / source.width, y: c.y / source.height })),
    };
    const last = groups[groups.length - 1];
    if (last && g.startUs - last.endUs < minGapUs) {
      last.endUs = g.endUs;
      last.points.push(...g.points);
    } else {
      groups.push(g);
    }
  }

  const k = source.width / (outputAspect * source.height); // rect h = w * k
  const zooms: Zoom[] = [];
  for (const g of groups) {
    const endUs = Math.min(g.endUs, durationUs);
    if (endUs - g.startUs < MIN_LEN_US) continue;
    const cx = g.points.reduce((s, p) => s + p.x, 0) / g.points.length;
    const cy = g.points.reduce((s, p) => s + p.y, 0) / g.points.length;
    const maxDx = Math.max(...g.points.map((p) => Math.abs(p.x - cx)));
    const maxDy = Math.max(...g.points.map((p) => Math.abs(p.y - cy)));
    const need = Math.max(zoomScale, 2 * maxDx + 0.05, (2 * maxDy + 0.05) / k);
    if (need > MAX_RECT_W) continue;
    const w = Math.min(1, need);
    const rect = lockAspect({ x: cx - w / 2, y: cy - (w * k) / 2, w, h: w * k }, outputAspect, source);
    zooms.push({
      id: `auto-${zooms.length + 1}`,
      startUs: g.startUs,
      endUs,
      rect,
      easeInUs: 400_000,
      easeOutUs: 400_000,
      easing: "easeInOutCubic",
      origin: "auto",
    });
  }
  return zooms;
}
