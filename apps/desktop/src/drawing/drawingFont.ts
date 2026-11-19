// The font of text strokes: the display font (Familjen Grotesk 700, like the captions), read from
// tokens.css. Shared by the preview, the export and the live overlay.

export function strokeFamily(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim() || "sans-serif";
  } catch {
    return "sans-serif";
  }
}

/** Waits until the display font can be drawn on a canvas (fonts load lazily). */
export async function loadDrawingFont(): Promise<void> {
  try {
    await document.fonts.load(`700 48px ${strokeFamily()}`);
  } catch {
    /* a fallback font is drawn */
  }
}

/** A text line's width in source pixels with the real font (canvas measureText). */
export function measureStrokeText(): (text: string, size: number) => number {
  const ctx = document.createElement("canvas").getContext("2d");
  const family = strokeFamily();
  return (text, size) => {
    if (!ctx) return Math.max(1, text.length) * size * 0.55;
    ctx.font = `700 ${size}px ${family}`;
    return ctx.measureText(text).width;
  };
}
