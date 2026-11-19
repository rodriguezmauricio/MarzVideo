# Canvas editing and the hybrid timeline: plan

Design: `docs/superpowers/specs/2026-11-19-canvas-editing-design.md`. Test first for every pure piece.

1. DESIGN-SYSTEM.md: "Timeline" gets the main track view and the toggle; new "Camera on the preview";
   DEVIATIONS.md entry (lanes no longer always visible).
2. Format: `pip.x`, `pip.y` optional (schema test: kept, range checked, missing is fine). Update the
   M1 format contract.
3. Compositor: `bubbleBox` honours x/y (tests: free box, clamped inside, circle shape). `pipPlace.ts`:
   `dropPip` snaps within 4% of the width or stays free with the nearest corner, `resizeBubble` keeps
   aspect and the opposite corner, clamps 8% to 60% of the width.
4. Timeline commands: `placeCamera` (one step, same pip returns `p`), `updateCamera` drops x/y on a
   corner pick and compares x/y.
5. Editor: Selection kind `camera`; `CameraOverlay` with a draft store; Preview hit test (camera
   first), draws the draft, caption; Delete ignores the camera.
6. `mainTrack.ts`: items for the Edits track and `packRows` (tests). Timeline renders the main view;
   App keeps the view in `localStorage` (`marz.timeline.lanes`), G toggles; CSS for the Edits track.
7. Checks: typecheck, tests, design:check, cargo test; Edge at 1440 x 900 and 1280 x 720 on both
   samples, both views, a bubble drag, snap, resize and undo.
8. CLAUDE.md status line, commit on the branch (no merge).
