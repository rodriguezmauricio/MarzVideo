# Cursor and clicks: design

Date: 2026-11-19. Product spec section 8. Scope: cursor as its own layer with its real shapes, hide it for
the whole video or per section, click effects, cursor size. Not in scope: cursor smoothing (never), custom
cursor art, cursor bitmaps of app-specific cursors.

## What exists before this work

- `screen.mp4` is already captured WITHOUT the cursor (WGC `CursorCaptureSettings::WithoutCursor`, since the
  capture spike). Every Marz recording so far is cursor free.
- `events.jsonl` has `cursor` lines (position in captured pixels, at most one per frame slot, on change) and
  `click` lines (down and up, button, position). The input thread gets them from the low-level mouse hook and a
  16 ms `GetCursorPos` poll.
- The compositor draws one fixed white arrow from the `cursor` lines, scaled by output height. `edits.cursor.hidden`
  hides it for the whole video. `edits.clicks.effect` exists in the format (always `"none"`), nothing draws it.

## Recording (capture engine)

New line type in `events.jsonl` (old builds ignore unknown types):

```
{"tUs":16000,"type":"cursorShape","shape":"hand","px":32}
```

- `shape`: `arrow`, `hand`, `ibeam`, `wait`, `progress`, `cross`, `move`, `sizeNS`, `sizeWE`, `sizeNWSE`, `sizeNESW`,
  `no`, `help`, `hidden` (Windows hides the cursor, e.g. while typing in some apps), `other` (an app's own cursor:
  drawn as the arrow).
- `px`: the cursor's cell size in captured pixels (the bitmap size Windows draws, 32 at 100% scale, 48 at 150%,
  bigger with the accessibility pointer size).
- Written by the 16 ms poll (`GetCursorInfo`, handle compared with the system cursors from `LoadCursorW`) on the
  first poll after recording starts and on every change. Missing lines mean `arrow`, `px` 32.

`project.json` gets `source.cursor: "layer"` from new recordings. `"baked"` marks a recording whose picture has
the cursor drawn in (none from this app; imported clips later). Missing means `"layer"`, since every Marz
recording so far is cursor free.

## Project format (all optional, version stays 1)

```json
"edits": {
  "cursor": {
    "hidden": false,
    "size": 1.5,
    "sections": [{ "id": "cur-1", "startUs": 2000000, "endUs": 6000000, "hide": true, "clicks": false }]
  },
  "clicks": { "effect": "ripple", "style": "ripple", "color": "accent", "size": "M" }
}
```

- `cursor.size`: 1, 1.5 or 2 (missing: 1). Any other value reads as 1 and is kept on save.
- `cursor.sections`: cursor blocks in source time, never overlapping. Inside a block its `hide` and `clicks`
  decide; outside, the whole-video settings decide. Blocks this build cannot read are kept as they are.
- `clicks.effect`: `"none"` (off for the whole video) or the style. `style` remembers the picked style while
  effects are off (missing: `ripple`). `color`: a design token name, `accent` (default), `paper`, `ink`.
  `size`: `S`, `M` (default), `L`.

## Drawing (compositor, same code in preview and export)

- Cursor: drawn at the last `cursor` position at or before the frame time, with the last `cursorShape` at or
  before it. Kept exactly as recorded: no smoothing, no prediction. Not drawn when hidden by the rules above,
  when the shape is `hidden`, when the position is outside the visible (zoomed) area, or when the recording is
  `baked`.
- Size: `px / 32 x size option`, in captured pixels, then scaled like the picture (the zoom and the layout's
  screen box), so a zoom makes the cursor bigger exactly as it would have looked in the picture.
- Shapes are vector drawings of the Windows cursors (white fill, black outline), hotspot at the event position.
- Click effects come from `click` `down` lines (any button). One per click, drawn under the cursor and over the
  screen, under the camera. Sizes in captured pixels relative to the cursor cell (`R = 0.75 x px x S/M/L`
  0.7/1/1.4), scaled like the picture, so they follow zooms and layouts.
  - Ripple: a ring from 0.25 R to 1.6 R in 500 ms (ease out), fading out.
  - Pulse: a filled disc from 0.5 R to 1.1 R in 400 ms, 45% to 0 opacity.
  - Ring: a fixed ring of radius R held from the press to the release (at least 250 ms), no fade.
  - Line width R/6, at least 1 output pixel. Colour from `tokens.css`.
  - A click outside the visible area draws nothing.

## Editor

- Cursor lane, right under the Zoom lane, always real (label "Cursor" in paper, Later lane heights 22 / 44).
  One block per section, zoom-block geometry, paper fill, ink label: "Cursor off" (hide, no clicks), "Clicks only"
  (hide, clicks), "No clicks" (show, no clicks), "Cursor on" (show, clicks). Drag, trim, snap, select as layout
  blocks. Each change is one undo step.
- Tool ledger row "Hide cursor" (`cursor` icon, H): adds a 4 s "Cursor off" block at the playhead, in the free time
  after it.
- Cursor block selected: title "Cursor", Start and End cells, toggles "Hide cursor" and "Click effects", Length,
  note, "Delete block".
- Project panel "Cursor" section (replaces the two old toggles): "Hide cursor" (whole video), "Cursor size"
  1x / 1.5x / 2x, "Click effects" toggle, "Style" Ripple / Pulse / Ring, "Colour" swatches, "Effect size" S / M / L.
  A `baked` recording shows "Hide cursor" and "Cursor size" off with the note "This recording has the cursor in the
  picture. It cannot be hidden or resized." Click effects still work there.

## Tests

Format: parse and keep the new fields, unknown values tolerated. Timeline: add, update, remove sections (no
overlap, min length), setCursorSize, setClicks. Compositor: cursor rules (global, section, baked, hidden shape,
outside the zoom), size under zoom and layouts, click effect state per style and time, under a section.
Capture: `cursorShape` dedup and line format (Rust unit tests); a real recording on Windows with simulated moves
and clicks, frames checked for no cursor in `screen.mp4` and cursor plus effects in the exports.
