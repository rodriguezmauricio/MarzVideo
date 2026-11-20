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

/** Why a provider gave no answer. `off`, `noKey`, `badKey` and `unreachable` come from the
 * swappable providers (src-tauri/src/provider.rs); the rest from Claude Code or the validator. */
export type AiErrorKind = "notInstalled" | "notSignedIn" | "usageLimit" | "badResult" | "failed" | "cancelled" | "off" | "noKey" | "badKey" | "unreachable";

/** A provider failure the editor shows as one sentence; the rest of the pass still applies. */
export class AiProviderError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export const EMPTY_RESULT: AiResult = { mistakes: [], contextFillers: [], zooms: [] };
