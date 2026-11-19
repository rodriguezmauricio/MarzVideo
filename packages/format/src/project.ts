import { z } from "zod";

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const Us = z.number().int();

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).passthrough();

/** Tolerant enum fields: a value this build does not know is read as `fallback`, and the raw value
 * is kept in a hidden `__raw_<field>` key so `serializeProject` writes it back unchanged. A newer
 * app's project must never become unopenable here. */
const RAW = "__raw_";
const tolerant = (
  obj: unknown,
  fields: Record<string, { known: readonly string[]; fallback: string | undefined }>,
): unknown => {
  if (!obj || typeof obj !== "object") return obj;
  const o = { ...(obj as Record<string, unknown>) };
  for (const [field, { known, fallback }] of Object.entries(fields)) {
    const v = o[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || !known.includes(v)) {
      o[RAW + field] = v;
      if (fallback === undefined) delete o[field];
      else o[field] = fallback;
    }
  }
  return o;
};

const EASINGS = ["linear", "easeInOutCubic"] as const;
const ZOOM_ORIGINS = ["live", "auto", "manual", "ai"] as const;
const CUT_ORIGINS = ["manual", "ai"] as const;
const CUT_REASONS = ["silence", "filler", "mistake"] as const;

const ZoomSchema = z.preprocess(
  (v) =>
    tolerant(v, {
      easing: { known: EASINGS, fallback: "easeInOutCubic" },
      origin: { known: ZOOM_ORIGINS, fallback: "manual" },
    }),
  z
    .object({
      id: z.string(),
      startUs: Us,
      endUs: Us,
      rect: RectSchema,
      easeInUs: Us,
      easeOutUs: Us,
      easing: z.enum(EASINGS),
      origin: z.enum(ZOOM_ORIGINS),
      /** The zoom candidate an AI zoom was picked from (`k1..kN`). */
      candidateId: z.string().optional(),
    })
    .passthrough(),
);

const CutSchema = z.preprocess(
  (v) =>
    tolerant(v, {
      origin: { known: CUT_ORIGINS, fallback: "manual" },
      reason: { known: CUT_REASONS, fallback: undefined },
    }),
  z
    .object({
      id: z.string(),
      startUs: Us,
      endUs: Us,
      /** Absent means "manual". */
      origin: z.enum(CUT_ORIGINS).optional(),
      /** Why the AI pass cut it. An unknown reason is dropped from the type but kept on save. */
      reason: z.enum(CUT_REASONS).optional(),
    })
    .passthrough(),
);

const CAPTION_BREAKS = ["split", "join"] as const;
const CAPTION_STYLE_NAMES = ["inkBand", "paperBand", "accentBand", "plain"] as const;
const CAPTION_SIZES = ["S", "M", "L"] as const;
const CAPTION_POSITIONS = ["top", "middle", "bottom"] as const;

/** One export preset's caption style. Every field optional: missing means the preset default. An
 * unknown value is dropped from the type (so the default applies) and kept on save. */
const CaptionStyleSchema = z.preprocess(
  (v) =>
    tolerant(v, {
      style: { known: CAPTION_STYLE_NAMES, fallback: undefined },
      size: { known: CAPTION_SIZES, fallback: undefined },
      position: { known: CAPTION_POSITIONS, fallback: undefined },
    }),
  z
    .object({
      style: z.enum(CAPTION_STYLE_NAMES).optional(),
      size: z.enum(CAPTION_SIZES).optional(),
      position: z.enum(CAPTION_POSITIONS).optional(),
      highlight: z.boolean().optional(),
    })
    .passthrough(),
);

/** `edits.captions`: per-word text fixes and hidden words, caption splits and joins, keyed by
 * transcript word id; caption style per export preset. */
const CaptionEditsSchema = z
  .object({
    overrides: z.record(z.string()).default({}),
    hidden: z.array(z.string()).default([]),
    /** "split": a caption starts at this word. "join": no caption starts at this word. */
    breaks: z.record(z.unknown()).optional(),
    styles: z.record(z.unknown()).optional(),
  })
  .passthrough();

const AiKindsSchema = z
  .object({
    silences: z.boolean(),
    fillers: z.boolean(),
    mistakes: z.boolean(),
    zooms: z.boolean(),
    captions: z.boolean(),
  })
  .passthrough();

const RejectedAiEditSchema = z.union([
  z
    .object({ kind: z.literal("cut"), reason: z.enum(CUT_REASONS), fromWordId: z.string(), toWordId: z.string() })
    .passthrough(),
  z.object({ kind: z.literal("zoom"), candidateId: z.string() }).passthrough(),
]);

/** `edits.ai`: the AI pass settings and memory. `lastResult` is the AI provider's validated answer,
 * typed by `@marz/autoedit` (opaque here). */
const AiEditsSchema = z
  .object({
    paceUs: Us,
    kinds: AiKindsSchema,
    rejected: z.array(z.union([RejectedAiEditSchema, z.unknown()])).default([]),
    lastRun: z
      .object({ at: z.string(), provider: z.string(), model: z.string(), languages: z.array(z.string()) })
      .passthrough()
      .optional(),
    lastResult: z.unknown().optional(),
  })
  .passthrough();

const CORNERS = ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const;

/** The camera's picture-in-picture: corner, width as a share of the output width, gap to the edges
 * as a share of the output width. `shape` is only "rect" for now (masks come later). */
const PipSchema = z
  .object({
    corner: z.enum(CORNERS),
    widthFrac: z.number().positive().max(1),
    marginFrac: z.number().min(0).max(0.5),
    shape: z.string(),
  })
  .passthrough();

const LAYOUTS = ["pip", "side", "camera", "screen"] as const;
const SCENE_ORIGINS = ["live", "manual"] as const;
const BORDER_COLORS = ["paper", "ink", "accent"] as const;

/** A timed layout scene (source time). An unknown layout reads as "pip", an unknown origin as
 * "manual"; both raw values are kept on save. */
const SceneSchema = z.preprocess(
  (v) =>
    tolerant(v, {
      layout: { known: LAYOUTS, fallback: "pip" },
      origin: { known: SCENE_ORIGINS, fallback: "manual" },
    }),
  z
    .object({
      id: z.string(),
      startUs: Us,
      endUs: Us,
      layout: z.enum(LAYOUTS),
      origin: z.enum(SCENE_ORIGINS).default("manual"),
    })
    .passthrough(),
);

/** The camera border: width in pixels at 1080 output height, colour a design token name. */
const BorderSchema = z.preprocess(
  (v) => tolerant(v, { color: { known: BORDER_COLORS, fallback: "paper" } }),
  z.object({ width: z.number().min(0).max(32), color: z.enum(BORDER_COLORS) }).passthrough(),
);

/** `edits.camera`. Optional: missing means `DEFAULT_CAMERA_EDITS`. Scenes this build cannot read
 * stay in the list as they are (use `cameraScenes` for the valid ones). */
const CameraEditsSchema = z
  .object({
    visible: z.boolean(),
    mirror: z.boolean(),
    pip: PipSchema,
    border: BorderSchema.optional(),
    scenes: z.array(z.union([SceneSchema, z.unknown()])).default([]),
    /** True once the live layout presses of events.jsonl became scenes (never imported again). */
    liveImported: z.boolean().optional(),
  })
  .passthrough();

const SizeFps = z.object({ width: z.number().positive(), height: z.number().positive(), fps: z.number().positive() }).passthrough();

const ProjectSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    durationUs: Us.positive(),
    source: SizeFps,
    tracks: z
      .object({
        screen: z.object({ file: z.string(), offsetUs: Us }).passthrough(),
        mic: z
          .object({ file: z.string(), offsetUs: Us, volume: z.number(), muted: z.boolean() })
          .passthrough()
          .optional(),
        // The computer's sound (loopback), same shape as the mic. Optional: older projects have none.
        system: z
          .object({ file: z.string(), offsetUs: Us, volume: z.number(), muted: z.boolean() })
          .passthrough()
          .optional(),
        // The webcam, recorded as its own file. Optional: recordings without a camera have none.
        camera: z
          .object({ file: z.string(), offsetUs: Us, width: z.number(), height: z.number(), fps: z.number() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    output: SizeFps,
    zoomPresets: z
      .array(z.object({ id: z.string(), name: z.string(), rect: RectSchema }).passthrough())
      .default([]),
    edits: z
      .object({
        zooms: z.array(ZoomSchema).default([]),
        cuts: z.array(CutSchema).default([]),
        cursor: z.object({ hidden: z.boolean() }).passthrough().default({ hidden: false }),
        clicks: z.object({ effect: z.string() }).passthrough().default({ effect: "none" }),
        camera: CameraEditsSchema.optional(),
        captions: CaptionEditsSchema.optional(),
        ai: AiEditsSchema.optional(),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();

export type Rect = z.infer<typeof RectSchema>;
export type Zoom = z.infer<typeof ZoomSchema>;
export type Cut = z.infer<typeof CutSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ZoomPreset = Project["zoomPresets"][number];
export type CameraEdits = z.infer<typeof CameraEditsSchema>;
export type Pip = z.infer<typeof PipSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type LayoutKind = (typeof LAYOUTS)[number];
export type CameraBorder = z.infer<typeof BorderSchema>;
export type BorderColor = (typeof BORDER_COLORS)[number];
export type PipShape = "rect" | "rounded" | "circle" | "square";
export const LAYOUT_KINDS: readonly LayoutKind[] = LAYOUTS;
export const BORDER_COLOR_NAMES: readonly BorderColor[] = BORDER_COLORS;
export const PIP_SHAPES: readonly PipShape[] = ["rect", "rounded", "circle", "square"];
export type CutReason = (typeof CUT_REASONS)[number];
export type CaptionEdits = z.infer<typeof CaptionEditsSchema>;
export type AiKinds = z.infer<typeof AiKindsSchema>;
export type RejectedAiEdit =
  | { kind: "cut"; reason: CutReason; fromWordId: string; toWordId: string }
  | { kind: "zoom"; candidateId: string };
/** Written out (not `Omit<z.infer<...>>`): passthrough types carry an index signature that would
 * turn every key into `unknown` under `Omit`. */
export type AiEdits = {
  paceUs: number;
  kinds: AiKinds;
  rejected: RejectedAiEdit[];
  lastRun?: { at: string; provider: string; model: string; languages: string[] };
  lastResult?: unknown;
};

export const DEFAULT_AI_EDITS: AiEdits = {
  paceUs: 300_000,
  kinds: { silences: true, fillers: true, mistakes: true, zooms: true, captions: true },
  rejected: [],
};

export type CaptionBreak = (typeof CAPTION_BREAKS)[number];
export type CaptionStyleName = (typeof CAPTION_STYLE_NAMES)[number];
export type CaptionSize = (typeof CAPTION_SIZES)[number];
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];
/** The export presets that carry a caption style (`edits.captions.styles` keys). */
export type CaptionPresetId = "youtube" | "vertical";
export type CaptionStyleChoice = { style: CaptionStyleName; size: CaptionSize; position: CaptionPosition; highlight: boolean };
export const CAPTION_STYLE_LIST: readonly CaptionStyleName[] = CAPTION_STYLE_NAMES;
export const CAPTION_SIZE_LIST: readonly CaptionSize[] = CAPTION_SIZES;
export const CAPTION_POSITION_LIST: readonly CaptionPosition[] = CAPTION_POSITIONS;

/** Defaults keep the M2 output: YouTube two-line subtitles on an ink band, vertical word highlight. */
export const DEFAULT_CAPTION_STYLES: Record<CaptionPresetId, CaptionStyleChoice> = {
  youtube: { style: "inkBand", size: "M", position: "bottom", highlight: false },
  vertical: { style: "plain", size: "M", position: "bottom", highlight: true },
};

export const DEFAULT_CAPTION_EDITS: CaptionEdits = { overrides: {}, hidden: [], breaks: {}, styles: {} };

/** The AI settings in force: `edits.ai`, or the defaults. */
export function aiEdits(p: Project): AiEdits {
  const ai = p.edits.ai as AiEdits | undefined;
  return ai ?? DEFAULT_AI_EDITS;
}

/** The caption edits in force. `breaks` holds only the values this build knows. */
export type CaptionEditsInForce = {
  overrides: Record<string, string>;
  hidden: string[];
  breaks: Record<string, CaptionBreak>;
  styles: Record<string, unknown>;
};
export function captionEdits(p: Project): CaptionEditsInForce {
  const c = p.edits.captions ?? DEFAULT_CAPTION_EDITS;
  const breaks: Record<string, CaptionBreak> = {};
  for (const [id, v] of Object.entries(c.breaks ?? {}))
    if (typeof v === "string" && (CAPTION_BREAKS as readonly string[]).includes(v)) breaks[id] = v as CaptionBreak;
  return { overrides: c.overrides ?? {}, hidden: c.hidden ?? [], breaks, styles: c.styles ?? {} };
}

/** The caption style of an export preset: the stored fields over the preset default. */
export function captionStyleFor(p: Project, preset: CaptionPresetId): CaptionStyleChoice {
  const raw = (p.edits.captions?.styles ?? {})[preset];
  const parsed = raw === undefined ? null : CaptionStyleSchema.safeParse(raw);
  const s = parsed?.success ? parsed.data : {};
  const d = DEFAULT_CAPTION_STYLES[preset];
  return {
    style: s.style ?? d.style,
    size: s.size ?? d.size,
    position: s.position ?? d.position,
    highlight: typeof s.highlight === "boolean" ? s.highlight : d.highlight,
  };
}

/** Whether an edit came from the AI pass. */
export const isAiEdit = (e: { origin?: string }): boolean => e.origin === "ai";
export type Corner = (typeof CORNERS)[number];
export const PIP_CORNERS: readonly Corner[] = CORNERS;

/** Camera width as a share of the output width for the S, M, L sizes. */
export const PIP_SIZES = { S: 0.16, M: 0.22, L: 0.3 } as const;

export const DEFAULT_CAMERA_EDITS: CameraEdits = {
  visible: true,
  mirror: true,
  pip: { corner: "bottomRight", widthFrac: PIP_SIZES.M, marginFrac: 0.03, shape: "rect" },
  scenes: [],
};

/** The camera edits in force: `edits.camera`, or the defaults when it is missing. */
export function cameraEdits(p: Project): CameraEdits {
  return p.edits.camera ?? DEFAULT_CAMERA_EDITS;
}

/** Today's look: 1px paper. */
export const DEFAULT_CAMERA_BORDER: CameraBorder = { width: 1, color: "paper" };

export function cameraBorder(p: Project): CameraBorder {
  const b = cameraEdits(p).border;
  return b ? { width: b.width, color: b.color } : DEFAULT_CAMERA_BORDER;
}

const isScene = (s: unknown): s is Scene => {
  const r = s as Partial<Scene> | null;
  return !!r && typeof r === "object" && typeof r.id === "string" && typeof r.layout === "string" &&
    Number.isInteger(r.startUs) && Number.isInteger(r.endUs) && r.endUs! > r.startUs!;
};

/** The layout scenes this build can draw, sorted by start. */
export function cameraScenes(p: Project): Scene[] {
  return (cameraEdits(p).scenes as unknown[]).filter(isScene).sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
}

export function parseProject(json: unknown): Project {
  const result = ProjectSchema.safeParse(json);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new FormatError(`Invalid project.json: ${msg}`);
  }
  return result.data;
}

/** Puts the raw values of tolerant fields back. A field the editor changed since it was read keeps
 * the edited value; one still at its fallback (or removed) gets the original back. */
const FALLBACKS = new Set(["manual", "easeInOutCubic", "pip", "paper"]);
function restoreRaw(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(restoreRaw);
  if (!v || typeof v !== "object") return v;
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(src)) {
    if (k.startsWith(RAW)) continue;
    out[k] = restoreRaw(val);
  }
  for (const [k, raw] of Object.entries(src)) {
    if (!k.startsWith(RAW)) continue;
    const field = k.slice(RAW.length);
    const cur = src[field];
    if (cur === undefined || (typeof cur === "string" && FALLBACKS.has(cur))) out[field] = raw;
  }
  return out;
}

export function serializeProject(p: Project): string {
  return JSON.stringify(restoreRaw(p), null, 2) + "\n";
}
