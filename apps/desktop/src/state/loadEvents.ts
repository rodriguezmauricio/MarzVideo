import { parseEvents, type MarzEvent } from "@marz/format";

/** Read events.jsonl; if it is missing, empty or unreadable the recording still opens, without events. */
export async function loadEventsOrEmpty(read: () => Promise<string>): Promise<{ events: MarzEvent[]; warning: string | null }> {
  try {
    const { events } = parseEvents(await read());
    return { events: [...events].sort((a, b) => a.tUs - b.tUs), warning: null };
  } catch (err) {
    console.warn("events.jsonl not usable:", err instanceof Error ? err.message : err);
    return {
      events: [],
      warning: "No usable events file. Click effects and auto zoom are unavailable. You can still add zooms and cuts by hand.",
    };
  }
}
