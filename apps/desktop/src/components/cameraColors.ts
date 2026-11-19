/** The camera border and drawing colours from tokens.css (no colour is written anywhere else). */
export type TokenColors = Record<"paper" | "ink" | "accent" | "rec", string>;

let cached: TokenColors | null = null;

export function tokenColors(): TokenColors {
  if (cached) return cached;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const colors = { paper: v("--paper"), ink: v("--ink"), accent: v("--accent"), rec: v("--rec") };
  if (colors.paper && colors.ink && colors.accent && colors.rec) cached = colors;
  return colors;
}
