// Where the overlay takes the mouse. The overlay window covers the whole monitor but is
// click-through except over its controls: Rust (recorder.rs `hits`) reads the cursor and turns
// click-through off only inside these rects, or everywhere while `grab` (drawing or dragging).
import { useLayoutEffect, type RefObject } from "react";
import { recorderApi } from "./recorderApi";
import type { PxRect } from "./regionMath";

let last = "";

/** Every `[data-hit]` element under `root` plus `extra` (CSS pixels), after each render. Sent to
 * Rust only when it changed. */
export function useHits(root: RefObject<HTMLElement | null>, extra: PxRect[], grab: boolean): void {
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const rects = [...extra];
    el.querySelectorAll<HTMLElement>("[data-hit]").forEach((h) => {
      const b = h.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) rects.push({ x: b.left, y: b.top, w: b.width, h: b.height });
    });
    const key = JSON.stringify([rects, grab]);
    if (key === last) return;
    last = key;
    recorderApi().hits(rects, grab);
  });
}
