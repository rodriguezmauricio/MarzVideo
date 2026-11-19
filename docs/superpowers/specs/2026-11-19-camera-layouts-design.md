# Camera layouts design

Status: pre-approved overnight by Mauricio (via the master chat, 2026-11-19): "plan and build camera
layouts, he reviews at test time". Product spec section 7, the M2-level version.

## Goal

The camera stops being one fixed corner picture. It gets a mask (circle, square, rounded, plain), a
border, and timed layout scenes: corner bubble, side column, camera fullscreen, screen only. The
screen moves and resizes with the camera on a switch, with a short eased move. Scenes live on a
Layout lane, are switched live with hotkeys while recording, and export draws them exactly like the
preview.

Left out (later topics): motion paths, shape morph along a path, SVG or custom masks, smart 9:16
reframe, floating 9:16, shadows.

## What he gets

- Inspector, Project panel, Camera block: a Shape row (Plain, Rounded, Circle, Square) and a Border
  row (None, Thin, Thick) plus a border colour row (Paper, Ink, Accent).
- A real Layout lane (projects with a camera): one block per layout scene. Add with L (or the ledger
  row), drag, trim, delete, undo and redo like zooms. Selecting one opens a Layout inspector: start,
  end, layout picker.
- Between scenes the video shows the default layout (corner bubble with the Camera block's corner,
  size, shape and border).
- While recording: Ctrl+Shift+1 corner bubble, Ctrl+Shift+2 side column, Ctrl+Shift+3 camera
  fullscreen, Ctrl+Shift+4 screen only. Each press is logged in `events.jsonl`; when the editor
  opens the project the first time, the presses become layout blocks (origin Live).
- Preview and both export presets draw the same picture (one compositor function).

## The four layouts (on the 16:9 editor frame, `project.output`)

| Layout | Camera box | Screen box |
| --- | --- | --- |
| Corner bubble (`pip`) | The Camera block's corner, size and shape | Full frame |
| Side column (`side`) | Full height, 9:16 wide (608 px of 1920), on the corner's side (right for right corners) | The rest of the frame; the screen is fitted inside it (contain) |
| Camera fullscreen (`camera`) | Full frame | Full frame (covered) |
| Screen only (`screen`) | None | Full frame |

- The camera always fills its box by cover cropping around its centre (no stretching). In the
  corner bubble with Plain or Rounded the box has the camera's aspect, so nothing is cropped (as
  today).
- Masks (corner bubble only; side column and fullscreen are plain rectangles):
  Plain = rectangle; Rounded = corner radius 18% of the short side; Circle and Square = a square box
  whose side is 75% of the bubble width (S, M, L still pick the size), centre cropped.
- Border: width None (0), Thin (1 px at 1080, today's look), Thick (4 px at 1080), drawn inside the
  box along the mask; colour paper (default), ink or accent, read from `tokens.css` at run time.
- Zooms act on the screen inside its box; the cursor follows. "Show camera" off means screen only
  everywhere, scenes included.
- Vertical export letterboxes the 16:9 frame as today, so the layout is the same picture.

## Switching

A switch takes 400 ms from the scene boundary, ease in-out cubic. Screen box, camera box and corner
radius are interpolated. A camera that appears or leaves grows from (or shrinks to) the centre of its
box; the side column slides in from (or out to) its frame edge. A switch that starts inside another
switch starts from where that one is. Cuts are in source time like everything else: a cut over a
switch skips that part of the move.

While a zoom is being edited on the preview (zoom selected, paused) the preview shows screen only, so
the zoom area overlay matches the frame (as today it drops the zoom).

## Format (project.json, stays version 1, all optional)

```json
"edits": {
  "camera": {
    "visible": true,
    "mirror": true,
    "pip": { "corner": "bottomRight", "widthFrac": 0.22, "marginFrac": 0.03, "shape": "circle" },
    "border": { "width": 1, "color": "paper" },
    "scenes": [
      { "id": "layout-1", "startUs": 4000000, "endUs": 9000000, "layout": "side", "origin": "live" }
    ],
    "liveImported": true
  }
}
```

- `pip.shape`: `rect` (default), `rounded`, `circle`, `square`. An unknown value draws as `rect` and is
  kept on save (the field was already a free string).
- `border` (new, optional): `width` in pixels at 1080 output height (0, 1, 4), `color` one of `paper`,
  `ink`, `accent`. Missing = `{ width: 1, color: "paper" }`, today's look.
- `scenes` (reserved since the camera step, now used): `{ id, startUs, endUs, layout, origin }`,
  source time. `layout` is `pip`, `side`, `camera` or `screen`; an unknown layout reads as `pip` with
  the raw value kept on save. `origin` is `live` or `manual`. Scenes do not overlap (commands keep
  them apart); if a file has overlaps, the later start wins.
- `liveImported` (new, optional): true once the editor has turned the live layout presses of
  `events.jsonl` into scenes, so deleting them never brings them back.

## events.jsonl (additive)

```json
{"tUs":4000000,"type":"layout","layout":"side"}
```

Written by the engine on a layout hotkey while recording (not while paused; a repeat of the current
layout is skipped). The editor ignores them in a take without a camera. Older editors ignore unknown
event types. On
open, each press starts a scene that ends at the next press or the end; presses of `pip` only end the
previous scene.

## Code

- `packages/format`: schemas above, `cameraScenes(p)`, `cameraBorder(p)`, `LayoutEvent`.
- `packages/compositor/src/layout.ts`: `layoutBoxes`, `layoutAt(project, srcUs, out)` (screen box,
  camera box, radius) shared by preview and export; `frameAt` fits the screen into the screen box;
  `drawFrame` draws the camera with cover crop, mask and border.
- `packages/timeline`: `addScene`, `updateScene`, `removeScene`, `importLiveLayouts`, `updateCamera`
  takes shape and border.
- `apps/desktop`: Layout lane, Layout inspector, Camera block rows, L hotkey and ledger row, import on
  load, preview and export pass the border colours.
- `crates/capture`: `Hotkey::Layout(1..=4)`, `EventLog::layout`, `Session::layout`; Tauri
  `trigger_layout` and the hotkey route.

## Design (DESIGN-SYSTEM.md gets these, same style)

- Layout lane: real lane in its Later slot (projects with a camera), heights 22 / 44. Blocks like
  zoom blocks but paper fill, ink label ("Side column", "Camera", "Screen only", "Corner"); Live
  scenes carry the Live badge colours (accent fill) instead. Grips and selection ring as zoom blocks.
- Layout inspector: title "Layout" + origin badge; cells Start, End; a Layout row with a 2 x 2 grid of
  segmented buttons (Corner, Side, Camera, Screen; selected = ink fill); button "Delete layout".
- Camera block: Shape row (segmented: Plain, Round, Circle, Square), Border row (None, Thin, Thick),
  Colour row (three 22 px squares filled paper, ink, accent, 1px ink border, selected = 2px ink ring
  via an inner square). Every change is one undo step.
- Tool ledger: "Add layout" (L) row after Add cut, only for projects with a camera.
- Recorder: no new button or hint; the keys are listed with the other recorder hotkeys in
  DESIGN-SYSTEM.md.

## Not checked by this design

Real live switching needs a recording with the camera on this PC (owner check). Hotkeys
Ctrl+Shift+1..4 may be taken by another app; the existing hotkey warning line reports that.
