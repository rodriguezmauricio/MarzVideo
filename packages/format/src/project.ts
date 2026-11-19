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

/** `edits.captions`: per-word text fixes and hidden words, keyed by transcript word id. */
const CaptionEditsSchema = z
  .object({
    overrides: z.record(z.string()).default({}),
    hidden: z.array(z.string()).default([]),
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

/** `edits.camera`. Optional: missing means `DEFAULT_CAMERA_EDITS`. `scenes` is reserved for timed
 * layout scenes and kept as is. */
const CameraEditsSchema = z
  .object({
    visible: z.boolean(),
    mirror: z.boolean(),
    pip: PipSchema,
    scenes: z.array(z.unknown()).default([]),
  })
  .passthrough();

const SizeFps = z.object({ width: z.number(), height: z.number(), fps: z.number() }).passthrough();

const ProjectSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    durationUs: Us,
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
export type CutReason = (typeof CUT_REASONS)[number];
export type CaptionEdits = z.infer<typeof CaptionEditsSchema>;
export type AiKinds = z.infer<typeof AiKindsSchema>;
export type RejectedAiEdit =
  | { kind: "cut"; reason: CutReason; fromWordId: string; toWordId: string }
  | { kind: "zoom"; candidateId: string };
export type AiEdits = Omit<z.infer<typeof AiEditsSchema>, "rejected"> & { rejected: RejectedAiEdit[] };

export const DEFAULT_AI_EDITS: AiEdits = {
  paceUs: 300_000,
  kinds: { silences: true, fillers: true, mistakes: true, zooms: true, captions: true },
  rejected: [],
};

export const DEFAULT_CAPTION_EDITS: CaptionEdits = { overrides: {}, hidden: [] };

/** The AI settings in force: `edits.ai`, or the defaults. */
export function aiEdits(p: Project): AiEdits {
  const ai = p.edits.ai as AiEdits | undefined;
  return ai ?? DEFAULT_AI_EDITS;
}

export function captionEdits(p: Project): CaptionEdits {
  return p.edits.captions ?? DEFAULT_CAPTION_EDITS;
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
const FALLBACKS = new Set(["manual", "easeInOutCubic"]);
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
