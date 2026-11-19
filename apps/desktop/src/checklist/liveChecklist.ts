// The live side of the AI checklist, in the overlay page while recording: words from Rust's live
// transcription come in, open topics are matched locally and ticked ("auto"); when that leaves
// topics open, Claude Code is asked now and then (rate-limited, text only) and its finds tick "ai".
// docs/superpowers/specs/2026-11-19-ai-checklist-design.md
import {
  AI_SEND_MAX_US,
  AI_SEND_OVERLAP_US,
  CHECKLIST_AI_SCHEMA,
  checklistPrompt,
  matchTopics,
  readChecklistAnswer,
  shouldAskAi,
  type AskState,
  type LiveWord,
} from "@marz/autoedit";

export type LiveItem = { id: string; text: string; atUs: number | null };
export type TickBy = "auto" | "ai" | "hand";

export type LiveDeps = {
  tick: (id: string, atUs: number, by: TickBy) => unknown;
  /** Resolves with Claude's JSON answer; rejects with `{ kind }` (ai.rs `AiError`). */
  askAi: (prompt: string, schema: string) => Promise<string>;
  nowMs: () => number;
};

/** Words kept for matching (the matcher only needs 30 s windows; the ask at most 3 min). */
const KEEP_US = 600_000_000;
/** Claude errors that will not go away during this recording. */
const FINAL = new Set(["notInstalled", "notSignedIn", "usageLimit"]);

export class LiveChecklist {
  private words: LiveWord[] = [];
  /** Topics this page already ticked (Rust's state can lag behind). */
  private sent = new Set<string>();
  private ask: AskState = { lastAskMs: null, wordsSinceAsk: 0, inFlight: false, asks: 0, disabled: false };
  /** End of the transcript sent with the last ask. */
  private lastSentEndUs: number | null = null;
  private running: Promise<void> = Promise.resolve();

  constructor(private deps: LiveDeps) {}

  /** New words (recording time) with the topics as Rust reports them now. */
  onWords(words: LiveWord[], items: LiveItem[]): void {
    if (words.length === 0) return;
    this.words.push(...words);
    const end = this.words[this.words.length - 1]!.endUs;
    this.words = this.words.filter((w) => w.endUs >= end - KEEP_US);
    this.ask.wordsSinceAsk += words.length;
    let open = this.open(items);
    for (const h of matchTopics(open, this.words)) this.send(h.id, h.atUs, "auto");
    open = this.open(items);
    if (shouldAskAi(this.ask, this.deps.nowMs(), open.length)) this.askClaude(open);
  }

  /** Resolves when the running ask (if any) is done. */
  idle(): Promise<void> {
    return this.running;
  }

  private open(items: LiveItem[]): LiveItem[] {
    return items.filter((i) => i.atUs === null && !this.sent.has(i.id));
  }

  private send(id: string, atUs: number, by: TickBy): void {
    if (this.sent.has(id)) return;
    this.sent.add(id);
    this.deps.tick(id, atUs, by);
  }

  private askClaude(open: LiveItem[]): void {
    const end = this.words[this.words.length - 1]!.endUs;
    const from = Math.max(this.lastSentEndUs === null ? 0 : this.lastSentEndUs - AI_SEND_OVERLAP_US, end - AI_SEND_MAX_US);
    const part = this.words.filter((w) => w.startUs >= from);
    if (part.length === 0) return;
    const fromUs = part[0]!.startUs;
    this.ask = { ...this.ask, inFlight: true, asks: this.ask.asks + 1, lastAskMs: this.deps.nowMs(), wordsSinceAsk: 0 };
    this.lastSentEndUs = end;
    const ids = open.map((i) => i.id);
    this.running = this.deps
      .askAi(checklistPrompt(open, part), JSON.stringify(CHECKLIST_AI_SCHEMA))
      .then((answer) => {
        for (const h of readChecklistAnswer(answer, ids, fromUs, end)) this.send(h.id, h.atUs, "ai");
      })
      .catch((err: unknown) => {
        const kind = (err as { kind?: unknown } | null)?.kind;
        if (typeof kind === "string" && FINAL.has(kind)) this.ask.disabled = true;
      })
      .finally(() => {
        this.ask.inFlight = false;
      });
  }
}
