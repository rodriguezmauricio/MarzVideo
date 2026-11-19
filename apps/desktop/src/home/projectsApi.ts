import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import type { ProjectRow } from "./projectRows";
import type { ArchiveSettings, StorageStep, StorageView } from "./storageBar";

/** What the folder dialog gave back (projects.rs `Picked`). */
export type Picked = { kind: "cancelled" } | { kind: "notProject" } | { kind: "project"; dir: string; needsRecovery: boolean };

/** Archive and proxies (archive.rs). Every call runs in Rust; the page never names a folder. */
export interface StorageApi {
  settings(): Promise<ArchiveSettings>;
  /** Folder dialog; null when cancelled. Saved for next time. */
  pickDest(): Promise<string | null>;
  useSuggested(): Promise<string>;
  view(dir: string): Promise<StorageView>;
  archive(dir: string): Promise<StorageView>;
  removeRaw(dir: string): Promise<StorageView>;
  restore(dir: string): Promise<StorageView>;
  onProgress(cb: (p: { dir: string; step: StorageStep; pct: number }) => void): () => void;
}

/** Everything Home needs from the projects folder. */
export interface ProjectsApi {
  list(): Promise<ProjectRow[]>;
  pick(): Promise<Picked>;
  recover(dir: string): Promise<void>;
  discard(dir: string): Promise<void>;
  openRecorder(): Promise<void>;
  /** A small picture of the recording as a data URL, made once and cached by the app. Browser: none. */
  thumb?(dir: string): Promise<string>;
  /** A stopped recording whose files could not be finished: the sentence for the warning bar. */
  onRecordingFailed(cb: (text: string) => void): () => void;
  storage: StorageApi;
}

const tauriStorage: StorageApi = {
  settings: () => invoke<ArchiveSettings>("archive_settings"),
  pickDest: () => invoke<string | null>("pick_archive_dest"),
  useSuggested: () => invoke<string>("use_suggested_dest"),
  view: (dir) => invoke<StorageView>("project_storage", { dir }),
  archive: (dir) => invoke<StorageView>("archive_project", { dir }),
  removeRaw: (dir) => invoke<StorageView>("remove_raw_files", { dir }),
  restore: (dir) => invoke<StorageView>("restore_raw_files", { dir }),
  onProgress: (cb) => {
    const p = listen<{ dir: string; step: StorageStep; pct: number }>("archive://progress", (e) => cb(e.payload));
    return () => void p.then((u) => u());
  },
};

/** Browser only: a pretend archive in memory, for the design check. */
function fakeStorage(onChange: (dir: string, label: StorageView["label"]) => void): StorageApi {
  let settings: ArchiveSettings = { dest: null, suggested: String.raw`G:\My Drive\Marz Recorder` };
  const views = new Map<string, StorageView>();
  const fresh = (): StorageView => ({ label: null, archiveDir: null, archivedAt: null, rawFiles: ["screen.mp4", "camera.mp4"], rawBytes: 309_329_920, removed: [], usesProxies: false });
  const get = (dir: string) => views.get(dir) ?? fresh();
  const put = (dir: string, v: StorageView) => (views.set(dir, v), onChange(dir, v.label), v);
  return {
    settings: async () => settings,
    pickDest: async () => null,
    useSuggested: async () => ((settings = { ...settings, dest: settings.suggested }), settings.dest!),
    view: async (dir) => get(dir),
    archive: async (dir) => put(dir, { ...get(dir), label: get(dir).removed.length ? "rawRemoved" : "archived", archiveDir: `${settings.dest}/${dir}.marz`.replace(/\//g, "\\"), archivedAt: new Date().toISOString() }),
    removeRaw: async (dir) => put(dir, { ...get(dir), label: "rawRemoved", removed: get(dir).rawFiles, rawFiles: [], rawBytes: 0, usesProxies: true }),
    restore: async (dir) => put(dir, { ...get(dir), label: "archived", rawFiles: get(dir).removed, rawBytes: 309_329_920, removed: [], usesProxies: false }),
    onProgress: () => () => undefined,
  };
}

const tauriApi: ProjectsApi = {
  list: () => invoke<ProjectRow[]>("list_projects"),
  async pick() {
    const p = await invoke<{ kind: string; dir?: string; needs_recovery?: boolean }>("pick_project");
    if (p.kind === "project") return { kind: "project", dir: p.dir!, needsRecovery: !!p.needs_recovery };
    return p.kind === "notProject" ? { kind: "notProject" } : { kind: "cancelled" };
  },
  recover: async (dir) => void (await invoke<number>("recover_project", { dir })),
  discard: (dir) => invoke<void>("discard_project", { dir }),
  // Opens the recorder windows; a stopped recording comes back as `recorder://open-project`.
  openRecorder: () => invoke<void>("open_recorder"),
  thumb: (dir) => invoke<string>("project_thumb", { dir }),
  onRecordingFailed: (cb) => {
    const p = listen<string>("recorder://stop-failed", (e) => cb(e.payload));
    return () => void p.then((u) => u());
  },
  storage: tauriStorage,
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Browser only (`?home=fake`, `?home=empty`): fake rows for the design check. Every row opens the demo sample. */
function fakeApi(empty: boolean): ProjectsApi {
  const now = Date.now();
  let rows: ProjectRow[] = empty
    ? []
    : [
        { dir: "demo", name: "Pricing page walkthrough", duration_us: 192e6, zooms: 0, cuts: 0, edited_at: now - 20 * MIN, needs_recovery: true },
        { dir: "demo", name: "Checkout bug walkthrough", duration_us: 160e6, zooms: 3, cuts: 1, edited_at: now - 2 * HOUR - 5 * MIN, needs_recovery: false },
        { dir: "demo", name: "Onboarding tutorial, part 2", duration_us: 768e6, zooms: 9, cuts: 4, edited_at: now - 30 * HOUR, needs_recovery: false, storage: "archived" },
        { dir: "demo", name: "Pricing page, first take", duration_us: 421e6, zooms: 2, cuts: 6, edited_at: now - 9 * 24 * HOUR, needs_recovery: false, storage: "rawRemoved" },
      ];
  return {
    list: async () => rows,
    // A browser cannot hand over a folder, so this shows the "not a project" warning.
    pick: async () => ({ kind: "notProject" }),
    recover: async () => {},
    discard: async (dir) => {
      rows = rows.filter((r) => !(r.dir === dir && r.needs_recovery));
    },
    openRecorder: async () => {},
    onRecordingFailed: () => () => undefined,
    storage: fakeStorage(() => undefined),
  };
}

export function projectsApi(): ProjectsApi {
  if (isTauri()) return tauriApi;
  return fakeApi(new URLSearchParams(location.search).get("home") === "empty");
}
