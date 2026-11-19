# Export extras: plan (2026-11-19)

Design: `docs/superpowers/specs/2026-11-19-export-extras-design.md`. Test first for every step with logic.

1. DESIGN-SYSTEM.md: the new export panel rows, the codec note, the done line copy, the Home lede.
2. `apps/desktop/src/export/choices.ts` (+ test): `ExportChoices` per preset, read/write in local storage,
   `fpsOptions`, `resolvePreset(base, choices, sourceFps)` returning an `ExportPreset` with the size, fixed fps,
   bitrate and codec; `presetSize` shows codec when HEVC.
3. `encoderConfig.ts` (+ test): codec strings and levels by codec and height; `pickEncoderConfig` unchanged
   in shape; `pickWithFallback` tries HEVC then H.264 and says which one it got.
4. `exportVideo.ts`: composite landscape straight at the preset size; use the picked codec; return it.
   `sink.ts` (+ test): `codec` in the job.
5. Rust `crates/export` (+ tests): `VideoCodec` on `ExportJob`, `-f hevc` and `-tag:v hvc1`. Validation in
   `src-tauri/src/export.rs` unchanged apart from the field.
6. Rust `src-tauri/src/export_copy.rs` (+ tests): settings file, sidecar JSON, `copy_export` (part + rename,
   JSON last, refuses project folders). Commands `export_copy_settings`, `pick_export_copy_dest`,
   `clear_export_copy_dest`, `export_copy_to`. Register in `lib.rs`.
7. `exportStore.ts` + `ExportStatus.tsx` + CSS: rows, HEVC probe on panel open, copy after a good export, done
   line note. `exportUi.test.ts` for the copy-note text.
8. Home lede copy.
9. Checks: `pnpm typecheck`, `pnpm test`, `pnpm design:check`, `cargo test --workspace`; Edge 1440 x 900
   screenshots of the panel; real app exports of a copy in HEVC, 720p, 1440p and 24 fps, ffprobe each;
   size and speed numbers into `CLAUDE.md`.
