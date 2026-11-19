# Live drawing plan

Design: `docs/superpowers/specs/2026-11-19-live-drawing-design.md`. Branch `claude/live-drawing-d842df`.
Order follows the brief; cut from the end if time runs short.

1. Format (TDD): `DrawEvent` in `events.ts` (`add` / `remove` / `clear`); `edits.drawings` schema with
   tolerant `color` and kept unknown tools; `drawingStrokes(p)`; tests in `drawings.test.ts`.
2. Timeline (TDD): `importLiveDrawings(events)`, `updateStroke`, `removeStroke`, `strokeBounds`,
   `hitStroke`, `moveStroke`, `scaleStroke`; tests in `drawings.test.ts`.
3. Compositor (TDD): `strokesAt` (fade), `strokeToOutput` mapping through a `FrameSpec`, `drawStrokes`
   (canvas calls checked with a recording fake context), `drawFrame` optional layer.
4. Editor: import on load, Selection kind `drawing`, Drawing lane, preview click select, `DrawingOverlay`
   move and resize, Drawing inspector, Del, sample project gets strokes (`tools/make-sample`).
5. Export: `exportVideo.ts` passes the drawing layer; check preview vs export frame.
6. Recorder: `Hotkey::Draw`, `EventLog` draw lines (Rust tests), `Session::draw`, Tauri `toggle_draw`,
   `draw_op`, `RecState.drawing`; overlay `DrawLayer` with tools and tool strip; Draw button on the bar;
   fake mode `?fake&state=recording&draw` for the design check.
7. Checks: pnpm test, typecheck, design:check, cargo test; Edge 1440 x 900 and 1280 x 720 on the sample;
   Tauri app: "Drawing test" recording with simulated input (no mic), frames of `screen.mp4` show no
   strokes, YouTube and vertical exports show them.
8. Docs: DESIGN-SYSTEM.md sections, DEVIATIONS.md, LEARNINGS.md, M1 design format section, CLAUDE.md
   status line, hand-over note in the shared notes folder.
