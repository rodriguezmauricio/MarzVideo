import type { EditPassInput } from "./types";

const sec = (us: number) => (us / 1e6).toFixed(1);

/** The text sent to the AI. Only words, their times, the rule cuts and the numeric zoom candidates:
 * never file paths, audio or video. */
export function buildPrompt(input: EditPassInput): string {
  const lines: string[] = [];
  lines.push(
    "You edit a screen recording from its transcript. The speaker talks Brazilian Portuguese and English, sometimes both in one take.",
    "Answer only with the JSON object the schema asks for.",
    `The transcript below has ${input.words.length} words${input.words.length ? `, from ${sec(input.words[0]!.startUs)}s to ${sec(input.words[input.words.length - 1]!.endUs)}s` : ""}. Read all of it to the last word: mistakes and fillers happen everywhere, not only at the start.`,
    "",
    "Tasks:",
    "1. mistakes: find false starts, restarted sentences and repeated takes. When the speaker says something, stops and says it again, cut the earlier tries and keep the last good one. Cut from the first word of the bad try to its last word. Do not cut words that carry meaning that the later try does not repeat. When unsure, do not cut.",
    "2. contextFillers: list ids of single words that are pure filler here, like é, tipo, né, então, assim (Portuguese) or like, so, you know, basically (English). Only when they carry no meaning in that spot: \"é\" as the verb \"is\", \"tipo\" meaning \"type\" or \"like\" as a verb are not fillers.",
    "3. zooms: the candidates below are moments where the speaker clicked in one area of the screen. Pick a candidate only when the speech around it refers to what is on screen there (\"this button\", \"aqui\", \"clica aqui\", naming a menu). For each pick give the first and last word of what he says about that spot. Never invent a candidate id.",
    "",
    "Already cut by rules (silences and ums), do not list them again:",
  );
  if (input.ruleCuts.length === 0) lines.push("(none)");
  for (const c of input.ruleCuts) lines.push(`${c.reason} ${sec(c.startUs)}s-${sec(c.endUs)}s`);
  lines.push("", "Zoom candidates (id start-end):");
  if (input.candidates.length === 0) lines.push("(none)");
  for (const c of input.candidates) lines.push(`${c.id} ${sec(c.startUs)}s-${sec(c.endUs)}s`);
  lines.push("", "Language sections:");
  for (const s of input.sections) lines.push(`${s.language} ${sec(s.startUs)}s-${sec(s.endUs)}s`);
  lines.push("", "Words (id|start ms|text):");
  for (const w of input.words) lines.push(`${w.id}|${Math.round(w.startUs / 1000)}|${w.text}`);
  return lines.join("\n");
}
