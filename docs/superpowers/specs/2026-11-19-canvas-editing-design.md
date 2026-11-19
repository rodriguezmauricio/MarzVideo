# Canvas editing and the hybrid timeline: design

Status: pre-approved by Mauricio (round 4 brief, 2026-11-19: "design doc and plan, then build straight
through"). Product spec section 11.

## Goal

Edit the picture where it is: drag the corner camera bubble and the zoom area on the preview. And a
quieter timeline: one main track by default, the separate lanes one click (or G) away.

## What he gets

### On the preview (paused, 16:9 preview only)

- **Zoom area**: already built (select a zoom, drag inside to move, a corner to resize, locked to the
  output aspect, one undo step). Unchanged.
- **Camera bubble** (recordings with a camera, while the corner bubble shows at the playhead): a click
  on the bubble selects it. It shows the drawing box look: 2px dashed accent rectangle and the four
  12px corner handles. Drag inside to move it anywhere on the frame, pull a corner to resize it (the
  opposite corner stays, the camera aspect is kept). Let go near a corner (within 4% of the output
  width of where the bubble sits in that corner) and it snaps into that corner. Each drag is one undo
  step. Caption below the preview: "Drag the camera anywhere. Let go near a corner to snap".
- The Inspector shows the Project panel while the bubble is selected (the Camera block is there).
  Picking a corner in the Camera block puts the bubble back in that corner.
- Not available: in the vertical preview (V; the camera there is a fixed slot), while playing, while a
  zoom is edited, during a side, camera or screen layout, and mid switch.
- Strokes keep their current behaviour (click selects, drag moves, corners resize). The camera sits on
  top of strokes, so a click on the bubble picks the bubble.

### Timeline

- **Main track view** (new default): ruler, Screen (thumbnails), **Edits** (one track with every
  block), Mic (waveform). On Edits: zooms, suggested zooms, layout blocks, cursor blocks, drawing
  blocks and, with the vertical preview on, Frame blocks, each in its usual lane colours. Blocks that
  overlap in time stack in rows inside the track (first free row, earlier start first), so nothing
  hides another. Cuts stay as today: the red cap on the ruler and the hatched band down the whole
  track area. Drag, trim, snap, select, Del and undo work as on the lanes (same code).
- **Lanes view**: the current expanded screen (horizontal tool ledger, small preview, tall lanes:
  Screen, Mic, Zoom, Vertical, Cursor, Camera, System audio, Layout, Drawing, Captions).
- The header button reads "Show lanes" / "Main track" (`layers` icon, G). G toggles. The choice is
  remembered per user (browser storage of the app's webview, key `marz.timeline.lanes`).
- The old "lanes at Fit height in the normal screen" state goes away: two states, as the spec says.

## Format

One optional field, no version change: `edits.camera.pip.x` and `edits.camera.pip.y`, the bubble box's
left and top as shares of the output width and height (0 to 1). Present: the bubble sits there (kept
inside the frame); `corner` still says which side the side column uses (the nearest corner on drop).
Missing: the bubble sits in `corner` as before. Older builds ignore them (passthrough) and draw the
corner. Snapping into a corner removes both.

## Code

- `packages/compositor/src/layout.ts`: `bubble()` honours `pip.x/y`; exported as `bubbleBox`.
- `packages/compositor/src/pipPlace.ts` (new, pure): `dropPip(pip, box, out, cam)` (snap or free),
  `resizeBubble(box, corner, pointer, aspect, out)`, `pipFromBox`.
- `packages/timeline/src/commands.ts`: `placeCamera(pip)` command (replaces the whole pip, so x/y can
  be dropped); `updateCamera` compares x/y too and drops them when a corner is picked.
- `apps/desktop/src/components/CameraOverlay.tsx` (new): the bubble box, drag and resize, a draft store
  the preview draws while dragging.
- `apps/desktop/src/components/mainTrack.ts` (new, pure): the Edits track items and their rows.
- `Timeline.tsx`: the Edits track in the main view; `App.tsx`: the remembered view and G.
- Selection gains `{ kind: "camera" }`.

## Tests

Unit: bubble placement with and without x/y, drop snapping and clamping, resize keeps aspect and the
anchor, `placeCamera`/`updateCamera` undo behaviour, row packing. Browser (Edge, 1440 x 900 and
1280 x 720): the sample and the camera sample in both views, a bubble drag, a snap, a resize, undo.
