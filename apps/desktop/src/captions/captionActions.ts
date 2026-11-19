import { captionBreakFor, captionLines, captionStarts, captionWords, type CaptionLook } from "@marz/autoedit";
import { captionStyleFor, type Project, type Word } from "@marz/format";
import { setCaptionBreak } from "@marz/timeline";
import { useMemo } from "react";
import { useEditorStore } from "../state/editorStore";

/** The line building the preview shows (the preview preset's word highlight). */
export function previewLook(project: Project): CaptionLook {
  return captionStyleFor(project, useEditorStore.getState().captionPreset).highlight ? "highlight" : "subtitles";
}

/** Split (`wantStart`) or join at a word, one undo step. False when nothing changed. */
export function setCaptionStartAt(wordId: string, wantStart: boolean): boolean {
  const { project, words, apply } = useEditorStore.getState();
  if (!project) return false;
  const v = captionBreakFor(project, words, previewLook(project), wordId, wantStart);
  if (v === undefined) return false;
  apply(setCaptionBreak(wordId, v));
  return true;
}

export type WordCaptionState = {
  /** The word is in the captions (not cut, not hidden, captions on). */
  shown: boolean;
  /** It starts a caption. */
  start: boolean;
  /** It starts the very first caption (nothing to join with). */
  first: boolean;
};

/** Caption facts for every word, for the inspector, the transcript and the Captions lane. */
export function useCaptionFacts(): { starts: Set<string>; shown: Set<string>; firstId: string | null } {
  const project = useEditorStore((s) => s.project);
  const words = useEditorStore((s) => s.words);
  const preset = useEditorStore((s) => s.captionPreset);
  return useMemo(() => captionFacts(project, words, preset), [project, words, preset]);
}

export function captionFacts(project: Project | null, words: Word[], preset: "youtube" | "vertical") {
  if (!project || words.length === 0) return { starts: new Set<string>(), shown: new Set<string>(), firstId: null };
  const look: CaptionLook = captionStyleFor(project, preset).highlight ? "highlight" : "subtitles";
  const lines = captionLines(project, words, look);
  const shown = new Set(captionWords(project, words).map((w) => w.id));
  return { starts: captionStarts(lines), shown: lines.length ? shown : new Set<string>(), firstId: lines[0]?.words[0]?.id ?? null };
}

export function wordCaptionState(facts: ReturnType<typeof captionFacts>, wordId: string): WordCaptionState {
  return { shown: facts.shown.has(wordId), start: facts.starts.has(wordId), first: facts.firstId === wordId };
}
