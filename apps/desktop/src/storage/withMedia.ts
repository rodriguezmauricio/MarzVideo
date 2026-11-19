import { mediaFile, type ArchiveState } from "@marz/format";
import type { ProjectStorage } from "./types";

/** The project's storage with media URLs that follow `archive.json`: a raw video file removed after
 *  an archive is served from its proxy. Preview, timeline and export all load media through this. */
export function withMedia(base: ProjectStorage, archive: ArchiveState): ProjectStorage {
  return { ...base, fileUrl: (path) => base.fileUrl(mediaFile(archive, path)) };
}
