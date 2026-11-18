import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";
import type { ProjectRow } from "./projectRows";

/** What the folder dialog gave back (projects.rs `Picked`). */
export type Picked = { kind: "cancelled" } | { kind: "notProject" } | { kind: "project"; dir: string; needsRecovery: boolean };

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
        { dir: "demo", name: "Onboarding tutorial, part 2", duration_us: 768e6, zooms: 9, cuts: 4, edited_at: now - 30 * HOUR, needs_recovery: false },
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
  };
}

export function projectsApi(): ProjectsApi {
  if (isTauri()) return tauriApi;
  return fakeApi(new URLSearchParams(location.search).get("home") === "empty");
}
