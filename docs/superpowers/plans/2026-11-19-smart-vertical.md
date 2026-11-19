# Smart vertical: plan

Design: `docs/superpowers/specs/2026-11-19-smart-vertical-design.md`. Branch `claude/smart-vertical-4e8de8`.

1. Format: `packages/format/src/vertical.ts` (`verticalEdits`, tolerant fields, unknown holds kept). Tests.
2. Aim (TDD): `packages/timeline/src/reframe.ts`. Tests first: no events, one rest, two rests far apart (move
   arrives at the second), dead zone holds, quick flick ignored, click far away, min hold between moves, zoom
   start, excursion, holds win with eases, crop rect width, clamps, zoom area.
3. Commands: `packages/timeline/src/vertical.ts` (`addHold`, `updateHold`, `removeHold`, `setVertical`). Tests.
4. Compositor: `verticalBoxes`, `verticalLayoutAt` (via `layoutAt` with static boxes), `verticalFrameAt`,
   `verticalCaptionArea`; `captionLayout` area option. Tests.
5. App: `drawVertical` shared helper; Preview vertical mode with Aim view; V strip button; Vertical lane with Frame
   blocks; Frame inspector and Vertical block; F hotkey; selection kind `frame`.
6. Export: Follow draws `drawVertical`, Fit keeps the letterbox; panel row "Follow the action"; captions use the
   safe area.
7. DESIGN-SYSTEM.md entries first (strip button, Aim view, Vertical lane, Frame inspector, Vertical block, export
   row), DEVIATIONS.md for anything off-mockup.
8. Checks: `pnpm test`, `pnpm typecheck`, `pnpm design:check`, `cargo test --workspace`; browser at 1440 x 900 and
   1280 x 720 on `samples/demo.marz` and a camera sample; Tauri vertical export on a copy "Vertical test" with
   frames pulled by FFmpeg.
9. LEARNINGS.md, CLAUDE.md status line, commit on the branch.
