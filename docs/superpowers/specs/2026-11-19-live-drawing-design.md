# Live drawing design

Status: pre-approved overnight by Mauricio (via the master chat, 2026-11-19): "plan and build live drawing,
he reviews at test time". Product spec section 6.

## Goal

While recording he can draw on the screen (pen, highlighter, arrow, rectangle, ellipse, text), erase and
clear, without the drawing being burned into `screen.mp4`. Every stroke is saved as a vector object with an
appear and a disappear time. In the editor each stroke can be selected, moved, resized, recoloured, retimed
or deleted, with undo. Preview and both export presets draw the strokes the same way, following zooms and
layouts.

Left out: pressure, other shapes, the stroke being drawn as an animation (strokes fade in and out over
150 ms instead), adding new strokes in the editor, a width picker while recording.

## What he gets

### While recording

- Ctrl+Shift+D (or the new Draw button on the recording bar) enters draw mode; the same key, the Done
  segment or Esc leaves it. Not while paused; Pause leaves draw mode.
- In draw mode the overlay window takes the whole mouse and the keyboard, the cursor is a crosshair, and a
  tool strip sits at the top centre (where the mode picker sits before recording): Pen (P), Highlighter
  (H), Arrow (A), Rectangle (R), Ellipse (O), Text (T), Eraser (E), Clear all (X), four colour squares
  (1 accent, 2 red, 3 paper, 4 ink) and Done (Esc). Pen and accent are picked the first time; the picks
  stay for the session.
- Pen and highlighter follow the drag. Arrow, rectangle and ellipse go from the press to the release. Text:
  a click opens a text field there; Enter places it, Esc drops it. Eraser: a click or drag removes every
  stroke it touches. Clear all removes all.
- Leaving draw mode clears the screen (the strokes end there) and gives the mouse back to the apps.
- The overlay is the existing recorder overlay window, already hidden from every capture
  (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` in `crates/capture/src/win/exclude.rs`), so nothing
  drawn is in `screen.mp4`.

### In the editor

- A real Drawing lane (projects with strokes): one block per stroke from its appear to its disappear time.
  Drag, trim, delete, undo and redo like layout blocks; overlapping strokes overlap on the lane (later on
  top).
- On the preview, while paused, a click on a stroke selects it (a click elsewhere on the picture selects
  nothing). The selected stroke shows its box (2px dashed accent, no dimming) with the four 12px zoom-area
  corner handles: drag inside to move, a corner to resize (the opposite corner stays; text keeps its
  aspect).
- Drawing inspector: title "Drawing" + origin badge (Live), cells Start, End, a Colour row (accent, red,
  paper, ink), a Width row (Thin, Medium, Thick; for text it reads Size: S, M, L), a Text field for text
  strokes, Length, and "Delete drawing". Each change is one undo step.
- Strokes live in source pixels, so they move with zooms and with the screen box of the layouts, and are
  clipped to the screen picture. The camera is drawn over them, the cursor over them too.

## Format

### `events.jsonl` (additive, written by the engine)

```json
{"tUs":4100000,"type":"draw","op":"add","id":"s1","startUs":3900000,
 "stroke":{"tool":"pen","color":"accent","width":6,"points":[[812,410],[815,412]]}}
{"tUs":5200000,"type":"draw","op":"remove","id":"s1"}
{"tUs":6000000,"type":"draw","op":"clear"}
```

- `add` is written when the stroke is finished; `startUs` is the press time (both recording time). Text
  strokes carry `"text":"..."` and one point (the top-left of the text).
- Points and width are captured-frame pixels (region origin subtracted, like cursor events).
- `remove` (eraser) and `clear` (Clear all, leaving draw mode, Pause) end strokes.
- Older editors ignore the unknown type.

### `project.json` (stays version 1, all optional)

```json
"edits": {
  "drawings": {
    "strokes": [
      { "id": "s1", "startUs": 3900000, "endUs": 6000000, "tool": "pen", "color": "accent", "width": 6,
        "points": [[812, 410], [815, 412]], "origin": "live" }
    ],
    "liveImported": true
  }
}
```

- `tool`: `pen`, `highlighter`, `arrow`, `rect`, `ellipse`, `text`. An unknown tool is kept in the list and
  not drawn (use `drawingStrokes(p)` for the drawable ones).
- `color`: `accent`, `rec`, `paper`, `ink` (design token names, resolved from `tokens.css` at run time). An
  unknown colour draws as `accent` and is kept on save.
- `width`: line width in source pixels. Highlighter lines are 4x as wide at 40% opacity. Text font size is
  8 x width (Familjen Grotesk 700, the caption font). Thin / Medium / Thick = 3 / 6 / 12 px at 1080 source
  height (S / M / L for text).
- `points`: source pixels. Pen and highlighter: the polyline. Arrow: tail, head. Rect and ellipse: two
  opposite corners. Text: top-left.
- `origin`: `live` or `manual` (no manual strokes yet).
- `liveImported`: true once the `draw` events became strokes, so deleted strokes never come back.
- Import: each `add` makes a stroke from `startUs` to the next `remove` of its id or `clear`, else the end
  of the recording.

## Drawing (compositor, shared by preview, export and the live overlay)

- `strokesAt(project, srcUs)`: the strokes visible at `srcUs` with their opacity (150 ms fade in after
  `startUs`, 150 ms fade out before `endUs`).
- `drawStrokes(ctx, strokes, map, colors, family)`: draws them through the frame's source-to-output map
  (`FrameSpec` srcRect to dstRect), clipped to the shown picture. Round caps and joins (strokes are video
  content, like the circle mask). Arrow head: two lines 3.5 x width long at 30 degrees. Rect and ellipse:
  outline only.
- `drawFrame` gains an optional drawing layer drawn after the screen and before the cursor and camera.
- `strokeBounds`, `hitStroke` (distance to the stroke within a tolerance) and `transformStroke` (move,
  scale about a point) live in `packages/timeline` with the commands `updateStroke`, `removeStroke`,
  `importLiveDrawings`.

## Code

- `crates/capture`: `Hotkey::Draw` (Ctrl+Shift+D), `EventLog::draw_add/draw_remove/draw_clear`,
  `Session::draw(op)`.
- `src-tauri`: `toggle_draw` and `draw_op` commands; draw mode in the live recording state
  (`RecState.drawing`), focus to the overlay on enter, clear on leave and on Pause.
- `apps/desktop/src/recorder`: `DrawLayer` (canvas, tools, text field, tool strip), Draw button on the bar.
- `apps/desktop/src`: Drawing lane, `DrawingOverlay` on the preview, Drawing inspector, import on load,
  export passes the layer.

## Not checked by this design

Real pen input on his PC (a tablet behaves like a mouse here). Ctrl+Shift+D may be taken by another app;
the existing hotkey warning line reports it.
