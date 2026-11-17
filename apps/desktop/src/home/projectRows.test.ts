import { expect, test } from "vitest";
import { bannerText, folderName, toRows, type ProjectRow } from "./projectRows";

const NOW = new Date("2026-11-17T12:00:00Z");
const ago = (ms: number) => NOW.getTime() - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const row = (over: Partial<ProjectRow>): ProjectRow => ({
  dir: "C:\\Videos\\Marz Recorder\\a.marz",
  name: "Checkout bug walkthrough",
  duration_us: 160_000_000,
  zooms: 3,
  cuts: 1,
  edited_at: ago(2 * HOUR),
  needs_recovery: false,
  ...over,
});

test("formats length and meta", () => {
  const [v] = toRows([row({})], NOW);
  expect(v).toMatchObject({ index: "01", name: "Checkout bug walkthrough", length: "02:40", meta: "3 zooms, 1 cut, edited 2 hours ago" });
});

test("singular forms", () => {
  const [v] = toRows([row({ zooms: 1, cuts: 1, edited_at: ago(1 * HOUR + 5 * MIN) })], NOW);
  expect(v!.meta).toBe("1 zoom, 1 cut, edited 1 hour ago");
  const [w] = toRows([row({ zooms: 2, cuts: 0, edited_at: ago(1 * MIN + 1000) })], NOW);
  expect(w!.meta).toBe("2 zooms, 0 cuts, edited 1 minute ago");
});

test("edited just now under a minute", () => {
  const [v] = toRows([row({ edited_at: ago(59_000) })], NOW);
  expect(v!.meta).toBe("3 zooms, 1 cut, edited just now");
  // a clock a little behind the file system still says just now
  const [w] = toRows([row({ edited_at: NOW.getTime() + 5000 })], NOW);
  expect(w!.meta).toBe("3 zooms, 1 cut, edited just now");
});

test("older edits read as days and weeks", () => {
  const meta = (ms: number) => toRows([row({ edited_at: ago(ms) })], NOW)[0]!.meta;
  expect(meta(30 * HOUR)).toBe("3 zooms, 1 cut, edited yesterday");
  expect(meta(3 * DAY + HOUR)).toBe("3 zooms, 1 cut, edited 3 days ago");
  expect(meta(8 * DAY)).toBe("3 zooms, 1 cut, edited last week");
  expect(meta(15 * DAY)).toBe("3 zooms, 1 cut, edited 2 weeks ago");
  expect(meta(70 * DAY)).toBe("3 zooms, 1 cut, edited 2 months ago");
});

test("a recording with no edits says when it was recorded", () => {
  const [v] = toRows([row({ zooms: 0, cuts: 0, edited_at: ago(15 * DAY) })], NOW);
  expect(v!.meta).toBe("No edits yet, recorded 2 weeks ago");
});

test("rows newest first", () => {
  const rows = toRows(
    [
      row({ dir: "old", name: "Old", edited_at: ago(3 * DAY) }),
      row({ dir: "new", name: "New", edited_at: ago(10 * MIN) }),
      row({ dir: "mid", name: "Mid", edited_at: ago(5 * HOUR) }),
    ],
    NOW,
  );
  expect(rows.map((r) => [r.index, r.dir])).toEqual([
    ["01", "new"],
    ["02", "mid"],
    ["03", "old"],
  ]);
});

test("rows that need recovery are left out of the list", () => {
  const rows = toRows([row({ dir: "crashed", needs_recovery: true, edited_at: ago(MIN) }), row({ dir: "ok" })], NOW);
  expect(rows.map((r) => [r.index, r.dir])).toEqual([["01", "ok"]]);
});

test("long recordings keep counting minutes", () => {
  const [v] = toRows([row({ duration_us: (72 * 60 + 5) * 1e6 })], NOW);
  expect(v!.length).toBe("72:05");
});

test("banner text names the recording and the safe length", () => {
  expect(bannerText(row({ name: "Pricing page walkthrough", duration_us: 192_000_000, needs_recovery: true }))).toEqual({
    lead: "Interrupted: Pricing page walkthrough.",
    rest: "The video up to 03:12 is safe.",
  });
});

test("folder name for messages drops the path and .marz", () => {
  expect(folderName("C:\\Users\\me\\Videos\\Marz Recorder\\Pricing page.marz")).toBe("Pricing page");
  expect(folderName("D:/clips/Demo.MARZ/")).toBe("Demo");
});
