/** The storage bar under a Home row (DESIGN-SYSTEM.md Home, "Storage"): what it says and which buttons. */

/** `project_storage` in archive.rs. */
export type StorageView = {
  label: "archived" | "rawRemoved" | null;
  archiveDir: string | null;
  archivedAt: string | null;
  rawFiles: string[];
  rawBytes: number;
  removed: string[];
  usesProxies: boolean;
};
export type ArchiveSettings = { dest: string | null; suggested: string | null };
export type StorageStep = "copying" | "checking" | "proxies" | "removing" | "restoring";
export type StorageButtonId = "useSuggested" | "pick" | "archive" | "remove" | "confirmRemove" | "keep" | "restore" | "close";
export type StorageButton = { id: StorageButtonId; label: string; accent?: boolean };

type Input = {
  name: string;
  settings: ArchiveSettings;
  view: StorageView;
  busy: { step: StorageStep; pct: number } | null;
  asking: boolean;
  error: { lead: string; text: string } | null;
};

const STEP: Record<StorageStep, string> = {
  copying: "Copying",
  checking: "Checking the copy",
  proxies: "Making proxies",
  removing: "Moving to the Recycle Bin",
  restoring: "Restoring",
};

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** "295 MB", "3.5 GB". */
export function bytes(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / MB))} MB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "19 Nov" from an ISO time (local date). */
function day(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : "";
}

/** "screen.mp4", "screen.mp4 and camera.mp4". */
const listFiles = (f: string[]) => (f.length <= 1 ? (f[0] ?? "") : `${f.slice(0, -1).join(", ")} and ${f.at(-1)}`);

export function storageBar(i: Input): { lead: string; rest: string; buttons: StorageButton[] } {
  const close: StorageButton = { id: "close", label: "Close" };
  if (i.busy) {
    const pct = i.busy.step === "removing" ? "" : ` ${Math.floor(i.busy.pct * 100)}%`;
    return { lead: `${STEP[i.busy.step]}${pct}`, rest: "Keep the app open.", buttons: [] };
  }
  const v = i.view;
  const where = v.archiveDir ?? "";
  let out: { lead: string; rest: string; buttons: StorageButton[] };
  if (v.removed.length > 0) {
    out = {
      lead: "Raw files removed.",
      rest: `Editing uses 720p proxies. Originals in ${where}.`,
      buttons: [{ id: "restore", label: "Restore from archive", accent: true }, { id: "archive", label: "Archive again" }, close],
    };
  } else if (v.archiveDir) {
    if (i.asking)
      return {
        lead: `Move ${listFiles(v.rawFiles)} (${bytes(v.rawBytes)}) to the Recycle Bin?`,
        rest: "The checked archive copy stays. Editing uses 720p proxies. Let Google Drive finish uploading first.",
        buttons: [{ id: "confirmRemove", label: "Remove" }, { id: "keep", label: "Keep" }],
      };
    const remove: StorageButton[] = v.rawFiles.length ? [{ id: "remove", label: "Remove raw files" }] : [];
    out = {
      lead: `Archived ${day(v.archivedAt)}.`,
      rest: `${where}. Raw video here: ${bytes(v.rawBytes)}.`,
      buttons: [...remove, { id: "archive", label: "Archive again" }, close],
    };
  } else if (i.settings.dest) {
    out = {
      lead: `Archive ${i.name}?`,
      rest: `Copies it to ${i.settings.dest} and checks every file. Nothing here changes.`,
      buttons: [{ id: "archive", label: "Archive", accent: true }, { id: "pick", label: "Change folder" }, close],
    };
  } else if (i.settings.suggested) {
    out = {
      lead: "Archive to Google Drive?",
      rest: `${i.settings.suggested}. Copies the whole project and checks every file.`,
      buttons: [{ id: "useSuggested", label: "Use this folder", accent: true }, { id: "pick", label: "Pick a folder" }, close],
    };
  } else {
    out = {
      lead: "Pick an archive folder.",
      rest: "Archive copies the whole project there and checks every file.",
      buttons: [{ id: "pick", label: "Pick a folder", accent: true }, close],
    };
  }
  return i.error ? { ...out, lead: i.error.lead, rest: i.error.text } : out;
}
