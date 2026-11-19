# Archive and proxies: plan (2026-11-19)

Design: `docs/superpowers/specs/2026-11-19-archive-proxies-design.md`. Test first, every step.

1. **Format** (`packages/format/src/archive.ts`): `parseArchiveState` (tolerant, unknown keys kept),
   `mediaFile(state, file)` (proxy when removed), `storageLabel(state)` ("archived", "rawRemoved",
   null). Tests: missing file, bad JSON shape, removed with and without proxy.
2. **Compositor**: `drawFrame` gets `srcScale` (default 1); the source crop is multiplied by it.
   `srcScaleFor(pictureWidth, sourceWidth)`. Tests on the crop numbers.
3. **Rust `archive.rs`** (src-tauri), pure functions with unit tests on temp folders:
   `archive_files` (skips cache, proxies, archive.json, tmp, part), `copy_verified` (hash while
   copying, read back, skip identical), `target_dir` (same id reuses, other id gets " (2)"),
   `verify_manifest`, `restore_files`, `read_state`/`write_state` (keeps unknown keys),
   `suggest_drive_root` (from a list of candidate roots), `proxy_args`.
4. **Rust commands**: `archive_settings`, `pick_archive_dest`, `accept_suggested_dest`,
   `archive_project`, `remove_raw_files`, `restore_raw_files`; progress on `archive://progress`.
   `read_text` may read `archive.json`. `ProjectRow.storage`. Thumbnails fall back to the proxy.
5. **Editor**: load `archive.json` with the project; `storage.fileUrl` goes through `mediaFile`
   (`withMedia`). Preview and export pass `srcScale`. Export: proxy ask in the Warning bar before
   the save dialog; "Restore from archive" calls the command and swaps the storage back.
6. **Home**: badge, Storage button, storage bar (destination, Archive, Remove raw files with
   confirm, Restore, progress). Fake API rows in the browser for the design check.
7. **Design system** first for 5 and 6 (DESIGN-SYSTEM.md Home "Storage bar", Export "Proxy ask").
8. **Checks**: `pnpm typecheck`, `pnpm test`, `pnpm design:check`, `cargo test --workspace`.
   App run on a copy "Archive test" with a scratch destination: archive, remove raw, edit and export
   from proxies, restore. Check each step's files (hashes, Recycle Bin, proxies, archive.json).
