import { blockSpans, captionLines } from "@marz/autoedit";
import type { CaptionBlock, CaptionStyle } from "@marz/compositor";
import type { CaptionStyleChoice, Project, Word } from "@marz/format";

/** Caption colours and font from tokens.css (no colour is written anywhere else). */
export function captionStyle(): CaptionStyle {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const ink = v("--brand-ink");
  const paper = v("--brand-paper");
  const accent = v("--brand-accent");
  if (!ink || !paper || !accent) throw new Error("caption tokens are missing");
  return { ink, paper, accent, family: v("--font-display") || "sans-serif" };
}

/** The caption blocks for a preset's style, in output time: word highlight builds short lines,
 * otherwise subtitle lines. */
export function captionBlocks(project: Project, words: Word[], style: Pick<CaptionStyleChoice, "highlight">): CaptionBlock[] {
  return words.length ? blockSpans(captionLines(project, words, style.highlight ? "highlight" : "subtitles")) : [];
}

/** Waits until the display font can be drawn on a canvas (fonts load lazily). */
export async function loadCaptionFont(family: string): Promise<void> {
  try {
    await document.fonts.load(`700 48px ${family}`);
  } catch {
    /* a fallback font is drawn; layout still holds */
  }
}
