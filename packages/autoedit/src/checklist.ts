// AI checklist matching (docs/superpowers/specs/2026-11-19-ai-checklist-design.md): cheap local
// keyword and fuzzy match of transcript words against each topic, plus the rate-limited Claude
// escalation (prompt, schema, answer check). Only text goes to the AI.

export type LiveWord = { text: string; startUs: number; endUs: number };
export type Topic = { id: string; text: string };
export type TopicHit = { id: string; atUs: number };

/** Keywords of a topic must be said inside this span to count together. */
export const MATCH_WINDOW_US = 30_000_000;

const STOP = new Set(
  (
    // English
    "a an the and or but if so of to in on at by for from with about into over as is are was were be been being am " +
    "it its this that these those there here what which who whom how why when where i you he she we they me my your our " +
    "their them us do does did done have has had will would can could should shall may might must not no yes just also " +
    "then than too very all any some each more most other such only own same up down out off again now let lets ok okay " +
    // Portuguese (accents removed)
    "o os as um uma uns umas de da do das dos em no na nos nas ao aos e ou mas se que como para pra por com sem sobre " +
    "eu tu ele ela nos vos eles elas meu minha seu sua isso isto aquilo este esta esse essa aqui ali la ja nao sim muito " +
    "mais menos tambem entao vai vamos ser estar ter foi era sao esta tem"
  ).split(" "),
);

/** Lower case, accents removed, punctuation to spaces, split. */
export function normalizeWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w !== "");
}

/** The distinct content words of a topic (all its words when only stop words remain). */
export function topicKeywords(text: string): string[] {
  const all = [...new Set(normalizeWords(text))];
  const content = all.filter((w) => !STOP.has(w));
  return content.length > 0 ? content : all;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Two normalized words match: equal, a shared stem (4+ letters), or a small typo. */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  const k = Math.max(4, shorter - 2);
  if (a.slice(0, k) === b.slice(0, k)) return true;
  if (shorter < 5) return false;
  return editDistance(a, b) <= (shorter >= 8 ? 2 : 1);
}

/** How many of `n` keywords must be said together. */
export const keywordsNeeded = (n: number): number => Math.max(1, Math.ceil(n * 0.6));

/** The topics the words cover, each with the start of the first matched word of the earliest window
 *  that has enough of its keywords. Topics not covered are left out. */
export function matchTopics(topics: Topic[], words: LiveWord[], windowUs = MATCH_WINDOW_US): TopicHit[] {
  const said = [...words].sort((a, b) => a.startUs - b.startUs).map((w) => ({ t: w.startUs, ws: normalizeWords(w.text) }));
  const out: TopicHit[] = [];
  for (const topic of topics) {
    const kws = topicKeywords(topic.text);
    if (kws.length === 0) continue;
    const need = keywordsNeeded(kws.length);
    const hits: { t: number; k: number }[] = [];
    for (const w of said) for (let k = 0; k < kws.length; k++) if (w.ws.some((x) => wordsMatch(x, kws[k]!))) hits.push({ t: w.t, k });
    for (let a = 0; a < hits.length; a++) {
      const seen = new Set<number>();
      for (let b = a; b < hits.length && hits[b]!.t - hits[a]!.t <= windowUs; b++) seen.add(hits[b]!.k);
      if (seen.size >= need) {
        out.push({ id: topic.id, atUs: hits[a]!.t });
        break;
      }
    }
  }
  return out;
}

// ---- Claude escalation ----

/** At least this long between two asks. */
export const AI_ASK_GAP_MS = 60_000;
/** New words needed since the last ask. */
export const AI_ASK_MIN_WORDS = 15;
/** Asks per recording. */
export const AI_ASK_MAX = 20;
/** The transcript sent starts this long before the last ask, and spans at most AI_SEND_MAX_US. */
export const AI_SEND_OVERLAP_US = 10_000_000;
export const AI_SEND_MAX_US = 180_000_000;

export type AskState = { lastAskMs: number | null; wordsSinceAsk: number; inFlight: boolean; asks: number; disabled: boolean };

export function shouldAskAi(s: AskState, nowMs: number, openTopics: number): boolean {
  return (
    !s.disabled &&
    !s.inFlight &&
    openTopics > 0 &&
    s.asks < AI_ASK_MAX &&
    s.wordsSinceAsk >= AI_ASK_MIN_WORDS &&
    (s.lastAskMs === null || nowMs - s.lastAskMs >= AI_ASK_GAP_MS)
  );
}

export const CHECKLIST_AI_SCHEMA = {
  type: "object",
  properties: {
    covered: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, atSec: { type: "number" } },
        required: ["id", "atSec"],
        additionalProperties: false,
      },
    },
  },
  required: ["covered"],
  additionalProperties: false,
} as const;

const sec = (us: number) => (us / 1_000_000).toFixed(1);

/** Transcript lines of up to 12 words, each with its start time in seconds. */
function timedLines(words: LiveWord[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    const part = words.slice(i, i + 12);
    lines.push(`[${sec(part[0]!.startUs)}] ${part.map((w) => w.text.trim()).join(" ")}`);
  }
  return lines;
}

/** The text sent to Claude: the open topics and the timed transcript. */
export function checklistPrompt(open: Topic[], words: LiveWord[]): string {
  return [
    "You check a live screen recording against the speaker's checklist of topics.",
    "Topics still open (id: text):",
    ...open.map((t) => `${t.id}: ${t.text}`),
    "",
    "Transcript of the last part (seconds from the start of the recording):",
    ...timedLines(words),
    "",
    "Which open topics did the speaker actually talk about in this transcript? Count a topic only when the speaker covered it,",
    "not when one of its words just appears. For each, give atSec: the time in seconds where they started on it.",
    'Answer {"covered": []} when none was covered.',
  ].join("\n");
}

/** Claude's answer as hits: known open ids once each, times clamped to the window that was sent. */
export function readChecklistAnswer(answer: unknown, openIds: string[], fromUs: number, toUs: number): TopicHit[] {
  let v: unknown = answer;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const covered = (v as { covered?: unknown } | null)?.covered;
  if (!Array.isArray(covered)) return [];
  const out: TopicHit[] = [];
  for (const c of covered) {
    const id = (c as { id?: unknown })?.id;
    const at = (c as { atSec?: unknown })?.atSec;
    if (typeof id !== "string" || !openIds.includes(id) || out.some((h) => h.id === id)) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    out.push({ id, atUs: Math.min(toUs, Math.max(fromUs, Math.round(at * 1_000_000))) });
  }
  return out;
}
