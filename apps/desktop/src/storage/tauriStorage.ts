import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ProjectStorage } from "./types";

/** App storage: a .marz folder on disk, read and written through the Rust commands in projects.rs.
 *  Media loads through the asset protocol. Rust only accepts folders Home listed or the dialog picked. */
export function createTauriStorage(dir: string): ProjectStorage {
  const sep = dir.includes("\\") ? "\\" : "/";
  return {
    readText: (path) => invoke<string>("read_text", { dir, path }),
    fileUrl: (path) => convertFileSrc(`${dir}${sep}${path}`),
    writeProjectJson: (text) => invoke<void>("write_project_json", { dir, text }),
  };
}
