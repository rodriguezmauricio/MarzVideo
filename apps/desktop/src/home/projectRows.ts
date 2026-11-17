import { count, mmss } from "../components/timecode";

/** One `.marz` folder in the projects folder, as `list_projects` returns it. */
export type ProjectRow = {
  dir: string;
  name: string;
  duration_us: number;
  zooms: number;
  cuts: number;
  /** project.json modified time (the crash marker's for a recording that needs recovery), ms since the epoch. */
  edited_at: number;
  needs_recovery: boolean;
};

/** A ruled row on Home: index "01", length "02:40", meta "3 zooms, 1 cut, edited 2 hours ago". */
export type RowView = { dir: string; index: string; name: string; length: string; meta: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", "last week", "2 weeks ago", "2 months ago". */
export function ago(thenMs: number, now: Date): string {
  const d = Math.max(0, now.getTime() - thenMs);
  const n = (unit: number) => Math.floor(d / unit);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${count(n(MIN), "minute")} ago`;
  if (d < DAY) return `${count(n(HOUR), "hour")} ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < WEEK) return `${n(DAY)} days ago`;
  if (d < 2 * WEEK) return "last week";
  if (d < 5 * WEEK) return `${n(WEEK)} weeks ago`;
  const months = Math.max(1, Math.floor(d / (30 * DAY)));
  return months === 1 ? "last month" : `${months} months ago`;
}

/** Recent projects, newest first. Recordings that need recovery are shown as banners instead. */
export function toRows(raw: ProjectRow[], now: Date): RowView[] {
  return raw
    .filter((r) => !r.needs_recovery)
    .sort((a, b) => b.edited_at - a.edited_at)
    .map((r, i) => ({
      dir: r.dir,
      index: String(i + 1).padStart(2, "0"),
      name: r.name,
      length: mmss(r.duration_us),
      meta:
        r.zooms === 0 && r.cuts === 0
          ? `No edits yet, recorded ${ago(r.edited_at, now)}`
          : `${count(r.zooms, "zoom")}, ${count(r.cuts, "cut")}, edited ${ago(r.edited_at, now)}`,
    }));
}

/** Recover banner copy: "Interrupted: <name>." in bold, then "The video up to <mm:ss> is safe." */
export function bannerText(r: ProjectRow): { lead: string; rest: string } {
  return { lead: `Interrupted: ${r.name}.`, rest: `The video up to ${mmss(r.duration_us)} is safe.` };
}
