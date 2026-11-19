import { parseTranscript, type Transcript } from "@marz/format";
import type { ProjectStorage } from "./types";

/** The project's `transcript.json`, or null when there is none yet or it cannot be read. */
export async function readTranscript(storage: ProjectStorage): Promise<Transcript | null> {
  let text: string;
  try {
    text = await storage.readText("transcript.json");
  } catch {
    return null;
  }
  try {
    return parseTranscript(JSON.parse(text));
  } catch (e) {
    console.warn("transcript.json is unreadable", e);
    return null;
  }
}
