import { checkImage, chooseFile } from "./pickImageFile";
import type { ProjectStorage } from "./types";

/** Browser/dev storage: the Vite dev server exposes samples/<name>.marz at /projects/<name>/. */
export function createHttpStorage(projectName: string): ProjectStorage {
  const base = `/projects/${encodeURIComponent(projectName)}`;
  return {
    async readText(path) {
      const res = await fetch(`${base}/${path}`);
      if (!res.ok) throw new Error(`Could not read ${path} (${res.status})`);
      return res.text();
    },
    fileUrl: (path) => `${base}/${path}`,
    async writeProjectJson(text) {
      const res = await fetch(`${base}/project.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: text,
        keepalive: true, // lets the final save on page close finish
      });
      if (!res.ok) throw new Error(`Could not save project.json (${res.status})`);
    },
    async pickBackgroundImage() {
      const file = await chooseFile(".jpg,.jpeg,.png,image/jpeg,image/png");
      if (!file) return null;
      const { bytes, path } = await checkImage(file);
      const res = await fetch(`${base}/${path}`, { method: "PUT", body: bytes as BodyInit });
      if (!res.ok) throw new Error(`Could not copy the image (${res.status})`);
      return path;
    },
  };
}
