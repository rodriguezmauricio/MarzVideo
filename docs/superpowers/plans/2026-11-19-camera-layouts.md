# Camera layouts plan

Design: `docs/superpowers/specs/2026-11-19-camera-layouts-design.md`. Branch `claude/camera-layouts-826937`.
TDD for format, timeline and compositor. Stage specific files; no merge, no push to the main branch.

1. Format: `pip.shape` values, `border`, typed `scenes` (tolerant `layout`), `liveImported`, layout
   event. Tests first (parse, defaults, unknown layout kept on save, events parse).
2. Compositor `layout.ts`: static boxes for the four layouts and the masks, `layoutAt` with the 400 ms
   eased switch (nested switches), screen box in `frameAt`, camera drawing with cover crop, radius,
   border. Tests first (boxes, interpolation, hidden camera, cursor mapping).
3. Timeline commands: `addScene`, `updateScene` (live becomes manual when moved), `removeScene`,
   no-overlap clamp, `importLiveLayouts(events)`, `updateCamera` shape and border. Tests first.
4. Editor: Layout lane (add, drag, trim, select, delete, undo), Layout inspector, Camera block rows,
   L hotkey and ledger row, import on load (no undo entry, saved), preview passes border colours.
   DESIGN-SYSTEM.md first.
5. Export: pass layout and border to `drawFrame` per frame; check preview against export frames.
6. Engine: `Hotkey::Layout`, `EventLog::layout`, `Session::layout`, Tauri route, setup bar hint.
   cargo tests for the event line and hotkey table.
7. Checks: pnpm test, typecheck, design:check, cargo test; browser 1440 x 900 and 1280 x 720 on the
   sample with a camera; Tauri app exports (both presets) of a copy named "Layouts test".
8. Docs: status in CLAUDE.md, DEVIATIONS.md, LEARNINGS.md, commit.
