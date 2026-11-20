import { z } from "zod";
import { FormatError } from "./project";
import { CURSOR_SHAPES, type CursorShape } from "./cursor";

const HeaderSchema = z.object({
  type: z.literal("header"),
  version: z.literal(1),
  source: z.object({ width: z.number(), height: z.number(), fps: z.number() }),
  startedAt: z.string(),
});

const Base = { tUs: z.number().int() };
const CursorSchema = z.object({ ...Base, type: z.literal("cursor"), x: z.number(), y: z.number() });
const CursorShapeSchema = z.object({
  ...Base,
  type: z.literal("cursorShape"),
  shape: z.string().transform((v): CursorShape => ((CURSOR_SHAPES as readonly string[]).includes(v) ? (v as CursorShape) : "other")),
  px: z.number().positive().default(32),
});
const ClickSchema = z.object({
  ...Base,
  type: z.literal("click"),
  button: z.enum(["left", "right", "middle"]),
  state: z.enum(["down", "up"]),
  x: z.number(),
  y: z.number(),
});
const ZoomEventSchema = z.object({ ...Base, type: z.literal("zoom"), presetId: z.string(), action: z.enum(["in", "out"]) });
const LayoutEventSchema = z.object({ ...Base, type: z.literal("layout"), layout: z.enum(["pip", "side", "camera", "screen", "float"]) });
const DrawPoint = z.tuple([z.number(), z.number()]);
/** Live drawing: `add` when a stroke is finished (`startUs` is the press), `remove` (eraser), `clear`. */
const DrawEventSchema = z.discriminatedUnion("op", [
  z.object({
    ...Base,
    type: z.literal("draw"),
    op: z.literal("add"),
    id: z.string(),
    startUs: z.number().int(),
    stroke: z
      .object({ tool: z.string(), color: z.string(), width: z.number(), points: z.array(DrawPoint), text: z.string().optional() })
      .passthrough(),
  }),
  z.object({ ...Base, type: z.literal("draw"), op: z.literal("remove"), id: z.string() }),
  z.object({ ...Base, type: z.literal("draw"), op: z.literal("clear") }),
]);
/** AI checklist: `list` once at the start (the topics), `tick` when a topic was covered (`atUs`). */
const ChecklistEventSchema = z.discriminatedUnion("op", [
  z.object({ ...Base, type: z.literal("checklist"), op: z.literal("list"), items: z.array(z.object({ id: z.string(), text: z.string() })) }),
  z.object({
    ...Base,
    type: z.literal("checklist"),
    op: z.literal("tick"),
    id: z.string(),
    atUs: z.number().int(),
    by: z.enum(["auto", "ai", "hand"]),
  }),
]);
/** A logged shortcut (opt-in): held modifiers then the key, e.g. ["Ctrl","Shift","S"]. */
const KeySchema = z.object({ ...Base, type: z.literal("key"), keys: z.array(z.string().min(1)).min(1) });
const PauseSchema = z.object({ ...Base, type: z.literal("pause") });
const ResumeSchema = z.object({ ...Base, type: z.literal("resume") });

const KNOWN = {
  cursor: CursorSchema,
  cursorShape: CursorShapeSchema,
  click: ClickSchema,
  zoom: ZoomEventSchema,
  layout: LayoutEventSchema,
  draw: DrawEventSchema,
  checklist: ChecklistEventSchema,
  key: KeySchema,
  pause: PauseSchema,
  resume: ResumeSchema,
} as const;

export type EventsHeader = Omit<z.infer<typeof HeaderSchema>, "type">;
export type CursorEvent = z.infer<typeof CursorSchema>;
export type CursorShapeEvent = z.infer<typeof CursorShapeSchema>;
export type ClickEvent = z.infer<typeof ClickSchema>;
export type ZoomEvent = z.infer<typeof ZoomEventSchema>;
export type LayoutEvent = z.infer<typeof LayoutEventSchema>;
export type DrawEvent = z.infer<typeof DrawEventSchema>;
export type ChecklistEvent = z.infer<typeof ChecklistEventSchema>;
export type KeyEvent = z.infer<typeof KeySchema>;
export type PauseEvent = z.infer<typeof PauseSchema>;
export type ResumeEvent = z.infer<typeof ResumeSchema>;
export type MarzEvent = CursorEvent | CursorShapeEvent | ClickEvent | ZoomEvent | LayoutEvent | DrawEvent | ChecklistEvent | KeyEvent | PauseEvent | ResumeEvent;

export function parseEvents(text: string): { header: EventsHeader; events: MarzEvent[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const first = lines[0];
  if (first === undefined) throw new FormatError("events.jsonl: missing header line");

  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(first);
  } catch {
    throw new FormatError("events.jsonl: header line is not valid JSON");
  }
  const h = HeaderSchema.safeParse(headerRaw);
  if (!h.success) throw new FormatError("events.jsonl: invalid header line");
  const { type: _type, ...header } = h.data;

  const events: MarzEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]!);
    } catch {
      if (i === lines.length - 1) break; // half-written final line after a crash
      throw new FormatError(`events.jsonl: line ${i + 1} is not valid JSON`);
    }
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !(type in KNOWN)) continue; // unknown types are ignored
    const parsed = KNOWN[type as keyof typeof KNOWN].safeParse(raw);
    if (!parsed.success) continue; // an odd event (e.g. an unlisted mouse button) must not make the recording unopenable
    events.push(parsed.data as MarzEvent);
  }
  return { header, events };
}
