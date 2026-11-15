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
