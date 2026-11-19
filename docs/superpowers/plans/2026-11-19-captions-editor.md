# Captions editor: plan

Design: `docs/superpowers/specs/2026-11-19-captions-editor-design.md`. Branch `claude/captions-editor-2649be`.

1. Format (TDD): `edits.captions.breaks` and `.styles` in `packages/format/src/project.ts`, tolerant values,
   `captionStyleFor(project, preset)` with defaults. Tests in `packages/format`.
2. Line building (TDD): `captionLines` honours `split` / `join`; `captionBlockIndex` helpers for the UI (which
   word starts a caption). `toVtt` beside `toSrt`. Tests in `packages/autoedit`.
3. Commands (TDD): `setCaptionBreak(wordId, kind|null)`, `setCaptionStyle(preset, patch)` in
   `packages/timeline/src/commands.ts`, one undo step each, not counted as touched ranges.
4. Compositor: `captionLayout` takes `{ band, size, position, highlight }`; drawing handles band colours, lit
   word box on bands that need it, and the outline for Plain. Tests in `packages/compositor`.
5. Editor wiring: the preview and export use the per-preset style; the preview preset lives in the editor store
   (`captionPreset`, replaces `captionLook`). Export writes `.srt` and `.vtt` (new Tauri command
   `export_write_vtt`, shares the atomic writer).
6. UI: DESIGN-SYSTEM.md first (Inspector tabs, Transcript panel, Captions block, split / join buttons), then
   `TranscriptPanel.tsx`, `CaptionsBlock.tsx`, inspector tabs, hotkeys T / S / J, Captions lane split marks.
7. Checks: `pnpm test`, `pnpm typecheck`, `pnpm design:check`, `cargo test --workspace`; browser at 1440 x 900 and
   1280 x 720 on the sample; Tauri exports of both presets on a copy "Captions test" of "AI test 19.35"; frames
   pulled with FFmpeg.
8. DEVIATIONS.md, LEARNINGS.md, CLAUDE.md status, commit on the branch.
