// Keys on the video for the preview and the export (DESIGN-SYSTEM.md "Keys in the video"): the same
// compositor call in both, colours and the mono font read from tokens.css.
import { drawKeys, keysLayout, keysMeasure, SAFE_AREA, type KeysMeasure, type KeysStyle } from "@marz/compositor";
import { keyItems, type Project } from "@marz/format";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Size = { width: number; height: number };

let cached: KeysStyle | null = null;

/** Ink, paper, accent (the fixed brand tokens) and the mono family. */
export function keysStyle(): KeysStyle {
  if (cached) return cached;
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const s = { ink: v("--brand-ink"), paper: v("--brand-paper"), accent: v("--brand-accent"), family: v("--font-mono") || "monospace" };
  if (!s.ink || !s.paper || !s.accent) throw new Error("The brand tokens are missing");
  cached = s;
  return s;
}

/** Waits until the mono font can be drawn on a canvas (fonts load lazily). */
export async function loadKeysFont(): Promise<void> {
  try {
    await document.fonts.load(`500 40px ${keysStyle().family}`);
  } catch {
    // Drawn in the fallback font.
  }
}

const measures = new WeakMap<object, KeysMeasure>();

/** The Reels and TikTok safe area of a vertical picture. */
export const verticalKeysArea = (out: Size) => ({
  x: out.width * SAFE_AREA.side,
  y: out.height * SAFE_AREA.top,
  w: out.width * (1 - 2 * SAFE_AREA.side),
  h: out.height * (1 - SAFE_AREA.top - SAFE_AREA.bottom),
});

/** Draw the combo shown at `srcUs` over the whole output (`vertical`: inside the safe area). */
export function drawKeysAt(ctx: Ctx, project: Project, srcUs: number, out: Size, vertical = false): void {
  if (keyItems(project).length === 0) return;
  const style = keysStyle();
  let m = measures.get(ctx);
  if (!m) {
    m = keysMeasure(ctx, style.family);
    measures.set(ctx, m);
  }
  const d = keysLayout(project, srcUs, out, m, vertical ? { area: verticalKeysArea(out), vertical: true } : undefined);
  if (d) drawKeys(ctx, d, style);
}
