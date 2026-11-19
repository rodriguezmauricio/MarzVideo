# Cursor and clicks: plan

Design: `docs/superpowers/specs/2026-11-19-cursor-clicks-design.md`. Branch `claude/cursor-clicks-08f5d3`.

1. Capture: `EventLog::cursor_shape` (dedup, line format, tests). Input thread polls `GetCursorInfo`, maps the
   handle to a shape name, reads the cell size once per handle. `project.json` writes `source.cursor: "layer"`.
2. Format (TDD): `cursorShape` event; `source.cursor`; `edits.cursor.size` and `sections`; `edits.clicks` style,
   colour, size; helpers `cursorEdits`, `clickSettings`, `cursorSections`.
3. Timeline (TDD): `addCursorSection`, `updateCursorSection`, `removeCursorSection`, `setCursorSize`, `setClicks`.
4. Compositor (TDD): `cursor.ts` (event index, `cursorStateAt`, `clickEffectsAt`), `frameAt` uses it; `drawFrame`
   draws effects then the cursor shape. Shapes in `cursorShapes.ts`.
5. Editor: Cursor lane in `Timeline.tsx`, selection kind `cursor`, H in the ledger and keys, `CursorBlock` and
   `CursorInspector`, colours passed to preview and export.
6. Sample: `make-sample` writes a few `cursorShape` lines.
7. Docs: DESIGN-SYSTEM.md sections first, DEVIATIONS.md, LEARNINGS.md, CLAUDE.md status.
8. Checks: pnpm test, typecheck, design:check, cargo test; browser 1440 x 900 and 1280 x 720; Tauri app real
   recording "Cursor test" with simulated mouse, exports of both presets, frames checked.
