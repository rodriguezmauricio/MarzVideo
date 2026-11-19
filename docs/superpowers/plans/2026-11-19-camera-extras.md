# Camera extras plan

Design: `docs/superpowers/specs/2026-11-19-camera-extras-design.md`. Test-first, one commit at the end on
`claude/camera-extras-5a1c71`.

1. Format: `float` layout, `star` and `custom` shapes, `customMask`, `transitions` schemas and readers;
   events accept `float`. Tests in `packages/format/src/cameraExtras.test.ts`.
2. Compositor masks: star, round-rect polygon, resample, SVG parse and normalize. Tests `masks.test.ts`.
3. Compositor layout: float box, polygon masks in `staticLayout`, per-pair length, easing, path, morph in
   `layoutAt`; vertical slot for float. Tests `layoutExtras.test.ts`.
4. Compositor draw: `drawCamera` polygon clip and border. Test with a recording context stub.
5. Timeline commands: `setTransition`, `setCustomMask`. Tests.
6. Capture: `LAYOUTS` + float, `Hotkey::Layout(5)`. cargo tests.
7. Design system first, then editor: Shape grid and SVG import, Float label, Switch in section, path overlay.
8. Checks: `pnpm typecheck`, `pnpm test`, `pnpm design:check`, `cargo test --workspace`; browser on the
   sample with a camera; Tauri app export of a copy of a camera project in both presets, frame grabs.
9. Docs: M1 format contract, CLAUDE.md status line, LEARNINGS, notes folder hand-over. Commit.
