import { z } from "zod";
import { FormatError } from "./project";

const HeaderSchema = z.object({
  type: z.literal("header"),
  version: z.literal(1),
  source: z.object({ width: z.number(), height: z.number(), fps: z.number() }),
  startedAt: z.string(),
});

const Base = { tUs: z.number().int() };
const CursorSchema = z.object({ ...Base, type: z.literal("cursor"), x: z.number(), y: z.number() });
const ClickSchema = z.object({
  ...Base,
  type: z.literal("click"),
  button: z.enum(["left", "right", "middle"]),
  state: z.enum(["down", "up"]),
  x: z.number(),
  y: z.number(),
});
const ZoomEventSchema = z.object({ ...Base, type: z.literal("zoom"), presetId: z.string(), action: z.enum(["in", "out"]) });
const PauseSchema = z.object({ ...Base, type: z.literal("pause") });
const ResumeSchema = z.object({ ...Base, type: z.literal("resume") });

const KNOWN = {
  cursor: CursorSchema,
  click: ClickSchema,
  zoom: ZoomEventSchema,
  pause: PauseSchema,
  resume: ResumeSchema,
} as const;

export type EventsHeader = Omit<z.infer<typeof HeaderSchema>, "type">;
export type CursorEvent = z.infer<typeof CursorSchema>;
export type ClickEvent = z.infer<typeof ClickSchema>;
export type ZoomEvent = z.infer<typeof ZoomEventSchema>;
export type PauseEvent = z.infer<typeof PauseSchema>;
export type ResumeEvent = z.infer<typeof ResumeSchema>;
export type MarzEvent = CursorEvent | ClickEvent | ZoomEvent | PauseEvent | ResumeEvent;

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
