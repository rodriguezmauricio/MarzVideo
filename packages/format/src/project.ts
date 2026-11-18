import { z } from "zod";

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const Us = z.number().int();

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).passthrough();

const ZoomSchema = z
  .object({
    id: z.string(),
    startUs: Us,
    endUs: Us,
    rect: RectSchema,
    easeInUs: Us,
    easeOutUs: Us,
    easing: z.enum(["linear", "easeInOutCubic"]),
    origin: z.enum(["live", "auto", "manual"]),
  })
  .passthrough();

const CutSchema = z.object({ id: z.string(), startUs: Us, endUs: Us }).passthrough();

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

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2) + "\n";
}
