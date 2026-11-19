import { describe, expect, it } from "vitest";
import { bytes, storageBar, type StorageView } from "./storageBar";

const fresh: StorageView = { label: null, archiveDir: null, archivedAt: null, rawFiles: ["screen.mp4", "camera.mp4"], rawBytes: 309_329_920, removed: [], usesProxies: false };
const archived: StorageView = { ...fresh, label: "archived", archiveDir: "G:\\My Drive\\Marz Recorder\\Take.marz", archivedAt: "2026-11-19T18:02:11Z" };
const removed: StorageView = { ...archived, label: "rawRemoved", rawFiles: [], rawBytes: 0, removed: ["screen.mp4", "camera.mp4"], usesProxies: true };
const ids = (b: ReturnType<typeof storageBar>) => b.buttons.map((x) => x.id + (x.accent ? "*" : ""));
const base = { name: "Take", busy: null, asking: false, error: null };

describe("storageBar", () => {
  it("suggests the Google Drive folder when no folder is set", () => {
    const b = storageBar({ ...base, settings: { dest: null, suggested: "G:\\My Drive\\Marz Recorder" }, view: fresh });
    expect(b.lead).toBe("Archive to Google Drive?");
    expect(b.rest).toBe("G:\\My Drive\\Marz Recorder. Copies the whole project and checks every file.");
    expect(ids(b)).toEqual(["useSuggested*", "pick", "close"]);
  });

  it("asks for a folder without Drive", () => {
    const b = storageBar({ ...base, settings: { dest: null, suggested: null }, view: fresh });
    expect(b.lead).toBe("Pick an archive folder.");
    expect(ids(b)).toEqual(["pick*", "close"]);
  });

  it("offers Archive once a folder is set", () => {
    const b = storageBar({ ...base, settings: { dest: "D:\\Backup", suggested: null }, view: fresh });
    expect(b.lead).toBe("Archive Take?");
    expect(b.rest).toBe("Copies it to D:\\Backup and checks every file. Nothing here changes.");
    expect(ids(b)).toEqual(["archive*", "pick", "close"]);
  });

  it("shows progress without buttons", () => {
    const s = { dest: "D:\\Backup", suggested: null };
    expect(storageBar({ ...base, settings: s, view: fresh, busy: { step: "copying", pct: 0.425 } }).lead).toBe("Copying 42%");
    expect(storageBar({ ...base, settings: s, view: fresh, busy: { step: "checking", pct: 0.8 } }).lead).toBe("Checking the copy 80%");
    expect(storageBar({ ...base, settings: s, view: fresh, busy: { step: "proxies", pct: 0.3 } }).lead).toBe("Making proxies 30%");
    expect(storageBar({ ...base, settings: s, view: fresh, busy: { step: "removing", pct: 0 } }).lead).toBe("Moving to the Recycle Bin");
    const b = storageBar({ ...base, settings: s, view: removed, busy: { step: "restoring", pct: 1 } });
    expect([b.lead, b.rest, b.buttons.length]).toEqual(["Restoring 100%", "Keep the app open.", 0]);
  });

  it("archived: the folder, the raw size, remove and archive again", () => {
    const b = storageBar({ ...base, settings: { dest: "G:\\x", suggested: null }, view: archived });
    expect(b.lead).toBe("Archived 19 Nov.");
    expect(b.rest).toBe("G:\\My Drive\\Marz Recorder\\Take.marz. Raw video here: 295 MB.");
    expect(ids(b)).toEqual(["remove", "archive", "close"]);
  });

  it("the remove confirm names the files and says the copy stays", () => {
    const b = storageBar({ ...base, asking: true, settings: { dest: "G:\\x", suggested: null }, view: archived });
    expect(b.lead).toBe("Move screen.mp4 and camera.mp4 (295 MB) to the Recycle Bin?");
    expect(b.rest).toBe("The checked archive copy stays. Editing uses 720p proxies. Let Google Drive finish uploading first.");
    expect(ids(b)).toEqual(["confirmRemove", "keep"]);
  });

  it("raw files removed: restore first", () => {
    const b = storageBar({ ...base, settings: { dest: "G:\\x", suggested: null }, view: removed });
    expect([b.lead, b.rest]).toEqual(["Raw files removed.", "Editing uses 720p proxies. Originals in G:\\My Drive\\Marz Recorder\\Take.marz."]);
    expect(ids(b)).toEqual(["restore*", "archive", "close"]);
  });

  it("a failure keeps the buttons of the state", () => {
    const b = storageBar({ ...base, settings: { dest: "G:\\x", suggested: null }, view: archived, error: { lead: "Could not remove the raw files.", text: "camera.mp4 in the archive does not match." } });
    expect([b.lead, b.rest]).toEqual(["Could not remove the raw files.", "camera.mp4 in the archive does not match."]);
    expect(ids(b)).toEqual(["remove", "archive", "close"]);
  });
});

describe("bytes", () => {
  it("MB below 1 GB, GB with one decimal above", () => {
    expect(bytes(309_329_920)).toBe("295 MB");
    expect(bytes(3 * 1024 ** 3 + 500 * 1024 ** 2)).toBe("3.5 GB");
    expect(bytes(10)).toBe("1 MB");
  });
});
