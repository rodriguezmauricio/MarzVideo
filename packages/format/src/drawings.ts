import { z } from "zod";
import type { Project } from "./project";

/** Live drawing (docs/superpowers/specs/2026-11-19-live-drawing-design.md). `edits.drawings` is an
 * optional passthrough field: nothing here changes how `project.json` is parsed, so a stroke this
 * build cannot read stays in the file as it is. Use `drawingStrokes` for the drawable ones. */

export const STROKE_TOOLS = ["pen", "highlighter", "arrow", "rect", "ellipse", "text"] as const;
export const STROKE_COLORS = ["accent", "rec", "paper", "ink"] as const;
export type StrokeTool = (typeof STROKE_TOOLS)[number];
export type StrokeColor = (typeof STROKE_COLORS)[number];
export type Point = [number, number];

export type Stroke = {
  id: string;
  /** Source time the stroke appears and disappears. */
  startUs: number;
  endUs: number;
  tool: StrokeTool;
  color: StrokeColor;
  /** Line width in source pixels (text: font size is 8 x width). */
  width: number;
  /** Source pixels. Pen/highlighter: polyline. Arrow: tail, head. Rect/ellipse: two corners. Text: top-left. */
  points: Point[];
  text?: string;
  origin: "live" | "manual";
};

export type DrawingEdits = { strokes: unknown[]; liveImported?: boolean };

/** Font size of a text stroke for its width. */
export const TEXT_SIZE_PER_WIDTH = 8;
/** Thin, Medium, Thick at 1080 source height (S, M, L for text). */
export const STROKE_WIDTHS_1080 = { thin: 3, medium: 6, thick: 12 } as const;

const PointSchema = z.tuple([z.number(), z.number()]);

const StrokeSchema = z
  .object({
    id: z.string(),
    startUs: z.number().int(),
    endUs: z.number().int(),
    tool: z.enum(STROKE_TOOLS),
    color: z.string(),
    width: z.number().positive(),
    points: z.array(PointSchema).min(1),
    text: z.string().optional(),
    origin: z.string().optional(),
  })
  .passthrough();

const needs: Record<StrokeTool, number> = { pen: 1, highlighter: 1, arrow: 2, rect: 2, ellipse: 2, text: 1 };

/** Read one raw stroke; null when this build cannot draw it. An unknown colour reads as accent. */
export function readStroke(raw: unknown): Stroke | null {
  const r = StrokeSchema.safeParse(raw);
  if (!r.success) return null;
  const s = r.data;
  if (s.endUs <= s.startUs || s.points.length < needs[s.tool]) return null;
  if (s.tool === "text" && !s.text) return null;
  const color = (STROKE_COLORS as readonly string[]).includes(s.color) ? (s.color as StrokeColor) : "accent";
  const out: Stroke = {
    id: s.id,
    startUs: s.startUs,
    endUs: s.endUs,
    tool: s.tool,
    color,
    width: s.width,
    points: s.points.map((p) => [p[0], p[1]] as Point),
    origin: s.origin === "live" ? "live" : "manual",
  };
  if (s.text !== undefined) out.text = s.text;
  return out;
}

/** `edits.drawings` as stored, or an empty one. */
export function drawingEdits(p: Project): DrawingEdits {
  const d = (p.edits as Record<string, unknown>).drawings as { strokes?: unknown; liveImported?: unknown } | undefined;
  if (!d || typeof d !== "object") return { strokes: [] };
  const out: DrawingEdits = { ...(d as object), strokes: Array.isArray(d.strokes) ? d.strokes : [] };
  if (typeof d.liveImported === "boolean") out.liveImported = d.liveImported;
  return out;
}

/** The strokes this build can draw, sorted by start (then by their order in the file). */
export function drawingStrokes(p: Project): Stroke[] {
  return drawingEdits(p)
    .strokes.map(readStroke)
    .filter((s): s is Stroke => s !== null)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.startUs - b.s.startUs || a.i - b.i)
    .map(({ s }) => s);
}

/** Thin / Medium / Thick for a source height. */
export function strokeWidths(sourceHeight: number): { thin: number; medium: number; thick: number } {
  const k = sourceHeight / 1080;
  const w = (v: number) => Math.max(1, Math.round(v * k));
  return { thin: w(STROKE_WIDTHS_1080.thin), medium: w(STROKE_WIDTHS_1080.medium), thick: w(STROKE_WIDTHS_1080.thick) };
}
