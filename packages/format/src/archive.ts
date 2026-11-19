/** `archive.json` in a `.marz` folder (optional, written only by the app; see
 * docs/superpowers/specs/2026-11-19-archive-proxies-design.md). Read tolerantly: anything this
 * build does not understand is left out of the type (the app keeps it on disk). */

export type ArchivedFile = { path: string; size: number; sha256: string };
export type ArchiveState = {
  archive: { dir: string; at: string; files: ArchivedFile[] } | null;
  /** Raw file name to proxy path, e.g. "screen.mp4" to "proxies/screen.mp4". */
  proxies: Record<string, string>;
  /** Raw files moved out of the folder after a verified archive. */
  removed: string[];
};

export const EMPTY_ARCHIVE_STATE: ArchiveState = { archive: null, proxies: {}, removed: [] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseArchiveState(json: unknown): ArchiveState {
  if (!isObj(json)) return EMPTY_ARCHIVE_STATE;
  const a = json.archive;
  const archive =
    isObj(a) && typeof a.dir === "string" && a.dir
      ? {
          dir: a.dir,
          at: typeof a.at === "string" ? a.at : "",
          files: (Array.isArray(a.files) ? a.files : []).filter(
            (f): f is ArchivedFile => isObj(f) && typeof f.path === "string" && typeof f.size === "number" && typeof f.sha256 === "string",
          ).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
        }
      : null;
  const proxies: Record<string, string> = {};
  if (isObj(json.proxies)) for (const [k, v] of Object.entries(json.proxies)) if (typeof v === "string") proxies[k] = v;
  const removed = Array.isArray(json.removed) ? json.removed.filter((r): r is string => typeof r === "string") : [];
  return { archive, proxies, removed };
}

/** The file to play for raw track `file`: its proxy once the raw file is removed. */
export function mediaFile(state: ArchiveState, file: string): string {
  return state.removed.includes(file) ? (state.proxies[file] ?? file) : file;
}

/** True when the editor plays and exports from proxies. */
export const usesProxies = (state: ArchiveState): boolean => state.removed.some((f) => f in state.proxies);

/** The Home badge: archived, raw files removed, or none. */
export function storageLabel(state: ArchiveState): "archived" | "rawRemoved" | null {
  if (state.removed.length > 0) return "rawRemoved";
  return state.archive ? "archived" : null;
}
