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
      });
      if (!res.ok) throw new Error(`Could not save project.json (${res.status})`);
    },
  };
}
