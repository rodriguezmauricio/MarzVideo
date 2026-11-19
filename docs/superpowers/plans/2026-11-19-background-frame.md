# Background and frame: plan

Design: `docs/superpowers/specs/2026-11-19-background-frame-design.md`. Test first at each step.

1. Format: `packages/format/src/background.ts` (`BackgroundEdits`, `DEFAULT_BACKGROUND_EDITS`, `backgroundEdits`,
   `rawBackground`), `edits.background` typed optional in the schema, tests (defaults, unknown values, kept on save).
   M1 design doc format section.
2. Timeline: `setBackground(patch)` command in `packages/timeline/src/background.ts` (no-op returns `p`), tests.
3. Compositor: `background.ts` (`backgroundPx`, `framedBox`, `paintBackdrop`), `frameAt` sets
   `spec.background` and fits the screen into the frame; `opts.out` and `opts.fill` for the vertical window;
   `verticalFrameAt` aims the window into the framed box. `drawFrame` paints backdrop, shadow, rounded clip.
   Tests: off unchanged, frame box and dstRect, zoom stays inside the frame, side layout, vertical follow window
   aspect, cursor mapping.
4. Editor: Background block in the Project panel (`apps/desktop/src/components/BackgroundBlock.tsx`), preview
   drops the background while a zoom is edited. DESIGN-SYSTEM.md entry first.
5. Checks: typecheck, test, design:check, cargo test. Tauri app: copy a real project as "Background test",
   export both presets, frame grabs.
6. CLAUDE.md status line, commit.
