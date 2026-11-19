# Archive and proxies: design (2026-11-19)

Product spec section 13: a manual archive of a project, then the option to remove the heavy raw
files locally and keep lightweight proxies for editing.

## Decisions (from the owner, 2026-11-19)

- No Google sign-in, no API keys. Archive copies the whole `.marz` folder into a destination folder
  picked once and remembered by the app. Meant for the Google Drive for desktop folder
  (`G:\My Drive`), any folder works. The app detects a Drive folder and suggests it.
- The copy is verified (size and SHA-256 per file) before anything local is removed.
- Removing raw files is a separate, explicit step with a confirm that names what goes and says the
  archive copy stays.
- Proxies: small copies of `screen.mp4` and `camera.mp4` in `proxies/`. The editor plays, edits and
  exports with them when the raw files are gone. Export from proxies warns that it is lower quality
  and offers "Restore from archive", which copies the raw files back (verified).
- Raw tracks are never modified, only copied, or removed after a verified archive.
- Home shows "Archived" or "Raw files removed" per row.
- Format: optional additions only, `version` stays 1.

## What is removed, what stays

Only the video tracks are removed: `tracks.screen.file` and `tracks.camera.file`. They are the
weight (the 8-minute "AI test 19.35" take: screen 286 MB, mic 44 MB). Audio (`mic.wav`,
`system.wav`), `events.jsonl`, `transcript.json`, `cache/` and `project.json` stay. So export
audio, noise cleanup, loudness and transcription keep working at full quality with no change.

## Storage state: `archive.json` (new optional file in the folder)

The editor's undo history and autosave own `project.json`. The archive state must never be undone
or raced by an autosave, so it lives in its own file, written only by the app (Rust), read by the
editor and Home. An older build ignores it (it would fail to play a removed `screen.mp4`, which is
the same with any design).

```json
{
  "archive": {
    "dir": "G:\\My Drive\\Marz Recorder\\Checkout bug.marz",
    "at": "2026-11-19T18:02:11Z",
    "files": [{ "path": "screen.mp4", "size": 299892736, "sha256": "9f2c..." }]
  },
  "proxies": { "screen.mp4": "proxies/screen.mp4", "camera.mp4": "proxies/camera.mp4" },
  "removed": ["screen.mp4", "camera.mp4"],
  "removedAt": "2026-11-19T18:05:40Z"
}
```

- `archive.files`: every file copied, path relative to the folder (forward slashes).
- `proxies`: raw file name to proxy path. Present once proxies were made.
- `removed`: raw files moved out of the folder. Empty or missing: the raw files are here.
- Unknown keys are kept when the app rewrites the file.

The editor reads it through `read_text` (added to the readable list). It maps a removed file to its
proxy when it builds media URLs (`mediaFile`), so the preview, timeline thumbnails and export pick
the proxy with no other change. Proxies are 720p, so the compositor scales the source crop by the
picture's real width over `source.width` (`drawFrame` `srcScale`); zoom rects stay in source pixels.

## Archive (copy and verify)

1. Destination root: the remembered folder (app config `archive.json` setting), else the suggested
   Drive folder `<drive>:\My Drive\Marz Recorder` when a `My Drive` folder exists on any drive
   letter or in the user folder, else the person picks one in the folder dialog. The page never
   names a folder: the dialog and the suggestion run in Rust.
2. Target: `<root>\<folder name>.marz`. If it exists and holds another project (different `id`),
   `<name> (2).marz` and so on. Archiving again updates the same target.
3. Files: everything in the folder except `cache/`, `proxies/`, `archive.json`, `*.tmp`, `*.part`,
   symlinks. Each file is copied to `<target>\<path>.part` while its SHA-256 is computed, synced,
   renamed, then read back from the target and hashed again. Size or hash mismatch: the archive
   fails, nothing local changes. A file already in the target with the same size and hash is not
   copied again.
4. `archive.json` gets `archive` with the manifest.

Google Drive for desktop uploads the copy in the background; the app verifies the copy in the Drive
folder, not the upload. The remove confirm says so.

## Remove raw files

Only after an archive. Steps, all in Rust, any failure stops before anything is removed:
1. Make proxies if missing (FFmpeg: `scale=-2:min(720\,ih)`, libx264 CRF 30, veryfast, no B-frames,
   keyframe every 2 s, `-fps_mode passthrough`, no audio, faststart). Written as `.part`, renamed.
   Checked with ffprobe: duration within 0.5 s of the raw file.
2. Hash the raw files again and the archive copies again; both must match the manifest.
3. Move the raw video files to the Recycle Bin (never a hard delete; the owner empties the bin to
   free the space).
4. `archive.json` gets `removed` and `removedAt`.

## Restore from archive

For each removed file: copy from the archive target to `<file>.part`, hash, compare to the manifest,
rename. Then `removed` is cleared. Proxies stay (cheap, reused if removed again). Fails if the
archive folder is gone or a hash differs (the Drive copy may still be downloading: the message says
to wait and try again).

## UI

- Home row: a badge before the meta, "Archived" or "Raw files removed". A "Storage" button left of
  "Open" opens a storage bar under the row (the recover banner's frame) with the steps above, the
  progress ("Copying 42%", "Checking the copy", "Making proxies 30%") and the confirm.
- Editor: picking an export preset while raw files are removed first shows the Warning bar ask:
  "Raw files removed. This export uses the 720p proxies and looks softer." with "Export anyway" and
  "Restore from archive". Restore swaps the editor back to the raw files; the person then exports.
- Design entries: DESIGN-SYSTEM.md, Home "Storage bar" and Export "Proxy ask".

## Not in scope

Automatic or scheduled archive, Drive upload status, deleting the archive, archiving exports,
proxies for audio.
