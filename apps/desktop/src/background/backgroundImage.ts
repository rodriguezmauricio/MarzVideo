import { useEffect, useState } from "react";
import { backgroundEdits, type Project } from "@marz/format";
import type { ProjectStorage } from "../storage/types";

// design-check-ignore: the design doc file name, video background styles
/** Background image loading (design 2026-11-19-background-image-blur-design.md). One decoded bitmap per
 *  URL, shared by the preview and the export; a file that cannot be loaded resolves to null. */
const cache = new Map<string, Promise<ImageBitmap | null>>();

export function loadBackgroundImage(url: string): Promise<ImageBitmap | null> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await createImageBitmap(await res.blob());
      } catch {
        return null;
      }
    })();
    cache.set(url, p);
    // A missing file may be put back (restore, a new pick): try again next time.
    void p.then((img) => img || cache.delete(url));
  }
  return p;
}

/** The image the project's background needs, or null (style is not Image, or no image set). */
export function backgroundImagePath(project: Project): string | null {
  const b = backgroundEdits(project);
  return b.style === "image" ? b.image : null;
}

/** For the export: the decoded image, or null when the style needs none or the file is missing. */
export async function exportBackgroundImage(project: Project, storage: ProjectStorage): Promise<ImageBitmap | null> {
  const path = backgroundImagePath(project);
  return path ? loadBackgroundImage(storage.fileUrl(path)) : null;
}

export type BackgroundImageState = { image: ImageBitmap | null; status: "none" | "loading" | "ready" | "missing" };

/** The project's background image for the preview and the inspector, reloaded when the path changes. */
export function useBackgroundImage(project: Project, storage: ProjectStorage | null): BackgroundImageState {
  const path = backgroundImagePath(project);
  const url = path && storage ? storage.fileUrl(path) : null;
  const [state, setState] = useState<{ url: string | null; image: ImageBitmap | null; done: boolean }>({ url: null, image: null, done: true });
  useEffect(() => {
    if (!url) return;
    let on = true;
    setState({ url, image: null, done: false });
    void loadBackgroundImage(url).then((image) => on && setState({ url, image, done: true }));
    return () => {
      on = false;
    };
  }, [url]);
  if (backgroundEdits(project).style !== "image") return { image: null, status: "none" };
  if (!url) return { image: null, status: "missing" };
  if (state.url !== url || !state.done) return { image: null, status: "loading" };
  return state.image ? { image: state.image, status: "ready" } : { image: null, status: "missing" };
}
