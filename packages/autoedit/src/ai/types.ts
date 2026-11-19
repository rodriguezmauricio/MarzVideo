import type { Rect, Section, Word } from "@marz/format";
import type { CutSpan } from "../rules";

/** A click cluster the rules found; the AI may pick it as a zoom but never moves its rect. */
export type ZoomCandidate = { id: string; startUs: number; endUs: number; rect: Rect };

/** What the AI provider answers, after validation. Word ids are transcript word ids. */
export type AiResult = {
  mistakes: Array<{ fromWordId: string; toWordId: string; why: string }>;
  contextFillers: string[];
  zooms: Array<{ candidateId: string; fromWordId: string; toWordId: string }>;
};

export type EditPassInput = { words: Word[]; sections: Section[]; ruleCuts: CutSpan[]; candidates: ZoomCandidate[] };

export interface AiProvider {
  name: string;
  model: string;
  editPass(input: EditPassInput, signal: AbortSignal): Promise<AiResult>;
}

/** A provider failure the editor shows as one sentence; the rest of the pass still applies. */
export class AiProviderError extends Error {
  constructor(
    readonly kind: "notInstalled" | "notSignedIn" | "usageLimit" | "badResult" | "failed" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export const EMPTY_RESULT: AiResult = { mistakes: [], contextFillers: [], zooms: [] };
