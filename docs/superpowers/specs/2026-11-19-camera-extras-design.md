# Camera extras design

Status: pre-approved by Mauricio (round 4 brief from the main session, 2026-11-19: "build straight through").
Product spec section 7, the rest of it, on top of the camera layouts (`2026-11-19-camera-layouts-design.md`).

## Goal

The camera gets two more mask shapes (star, an imported SVG shape), a floating 9:16 panel layout, and
switches that can follow a drawn curve with a chosen length, easing and shape morph. A switch's path is
saved per layout pair, so every switch between the same two layouts (live hotkey ones too) follows it.

Already there: rounded rect (the Round mask) and the side column with the screen reflowed into the rest
of the frame (camera layouts). Nothing new for those.

Left out (later topics): drawing a free-form mask on the preview, more than one path per layout pair,
per-scene overrides, shadows on the camera, screen paths (the screen box still moves straight).

## What he gets

- Camera block Shape row: Plain, Round, Circle, Square, Star, Custom (3 x 2 grid). Custom asks for an SVG
  file the first time; a row "Custom shape: heart.svg" with "Import SVG" changes it later. A file with more
  than one shape, an open path or no path gives one line: "Use an SVG with one closed path." and changes nothing.
- Layout row: Corner, Side, Float, Camera, Screen. Float = a tall 9:16 camera panel floating over the
  full screen, on the corner's side. Live: Ctrl+Shift+5.
- Layout inspector, new "Switch in" section (when the block has a switch into it, i.e. the layout before it
  differs): "From Corner" line, Length (0.4, 0.8, 1.2 s), Easing (Smooth, Linear, In, Out), Morph (Along,
  At end), button "Straight path". With the layout selected and paused the preview shows the path: the
  start and end camera boxes as dashed outlines, the curve, and two square handles to drag. One drag is one
  undo step. A note says it applies to every switch from Corner to Side, live ones too.
- Preview, YouTube export and vertical export draw all of it with the same compositor code.

## Shapes

All masks are video content. In the corner bubble, Star and Custom use the Circle and Square box (a
square 75% of the bubble width, centre cropped).

- Star: five points, inner radius 50% of the outer, one point up, filling the box.
- Custom: one closed path from an SVG file, flattened to a polygon (3 to 512 points), its bounding box
  fitted into the unit square with its aspect kept and centred. Stored in `project.json` as numbers, never
  as SVG text or a file reference. The SVG is parsed as text (path `d` or polygon `points` only; nothing
  else in the file is read or kept), so no script or link inside it can run.
- Float panel and side column and fullscreen keep their own masks: Float is a Round mask (radius 18% of its
  short side) when the Camera block's shape is anything but Plain; Side and Camera stay plain rectangles.
- Border: inside the mask, along it (the same widths and colours).
- Vertical picture: the camera slot keeps no mask (as today); Float uses the slot like Corner and Side.

## Floating 9:16

On the 16:9 frame: camera box height 80% of the frame, width 9:16 of that (486 x 864 on 1920 x 1080),
the Camera block's margin from the side edge (right for right corners), centred vertically. The screen
stays full frame (the camera floats over it). A camera appearing as Float slides in from its edge like
the side column.

## Switches and paths

A switch between two layouts moves the camera box from its start box to its end box (unchanged:
start = the previous layout at rest or the camera mid-switch; a camera that appears or leaves grows from
its centre or slides from its edge). New, per layout pair (`from` to `to`), all optional:

- Length: 0.4 s (default), 0.8 s or 1.2 s, from the scene boundary.
- Easing: Smooth (ease in-out cubic, default), Linear, In (cubic), Out (cubic).
- Path: the camera box centre follows a cubic curve from the start centre to the end centre. The two
  control points are stored relative to that segment (`u` along it, `v` across it, a quarter turn
  clockwise on screen), so the same path bends the same way at any frame size and in the vertical
  picture. No path = straight line. When start and end centres are within 1 px the path is ignored.
- Morph: Along (default; size and shape blend over the whole move, as today) or At end (the camera
  travels the path in the first 70% at its start size and shape, then size and shape blend in the last 30%).
- Shape blend: two round-cornered rects blend their corner radius (as today, pixel identical). Any switch
  that involves Star or Custom blends outlines: both shapes are resampled to 96 points by length, starting
  at the top centre, clockwise, and each point moves straight to its partner.

The screen box still moves straight with the same length and easing.

## Format (project.json, version 1, all optional)

```json
"edits": {
  "camera": {
    "pip": { "corner": "bottomRight", "widthFrac": 0.22, "marginFrac": 0.03, "shape": "custom" },
    "customMask": { "name": "heart.svg", "points": [0.5, 0.1, 0.9, 0.4, 0.5, 0.95, 0.1, 0.4] },
    "scenes": [{ "id": "layout-1", "startUs": 4000000, "endUs": 9000000, "layout": "float", "origin": "manual" }],
    "transitions": [
      { "from": "pip", "to": "float", "durationUs": 800000, "easing": "easeInOutCubic", "morph": "end",
        "path": { "c1": [0.3, -0.4], "c2": [0.7, -0.4] } }
    ]
  }
}
```

- `pip.shape` gains `star` and `custom`. `custom` without a valid `customMask` draws as `circle`. Older
  builds draw unknown shapes as Plain (already the rule).
- `customMask` (new): `name` (file name, shown only), `points`: flat x, y pairs in 0..1, 3 to 512 points.
- Scene `layout` gains `float`. Older builds read it as `pip` and keep it on save (already the rule).
- `transitions` (new): one per `from` and `to` pair (later entries win). `durationUs` 100000 to 3000000,
  `easing` one of `linear`, `easeInOutCubic`, `easeInCubic`, `easeOutCubic` (unknown reads as
  `easeInOutCubic`), `morph` `blend` or `end` (unknown reads as `blend`), `path` optional with `c1`, `c2`
  as `[u, v]` numbers in -4..4. Entries this build cannot read stay in the list as they are.
- `events.jsonl` layout lines may carry `"layout":"float"` (Ctrl+Shift+5). Older editors drop unknown
  event lines (already the rule).

## Code

- `packages/format`: schemas, `cameraTransitions(p)`, `transitionFor(p, from, to)`, `customMask(p)`.
- `packages/compositor/src/masks.ts`: `starPolygon`, `parseSvgMask` (flatten M L H V C S Q T A Z), `resample`,
  `roundRectPolygon`, `maskPath`.
- `packages/compositor/src/layout.ts`: `staticLayout` float and polygon masks; `layoutAt` uses per-pair
  length, easing, path and morph. `LayoutState` gains optional `mask` (unit polygon); `cameraLayerFor` passes it on.
- `packages/compositor/src/draw.ts`: `drawCamera` clips to the polygon and draws the border along it.
- `packages/compositor/src/vertical.ts`: float uses the slot.
- `packages/timeline`: `setTransition(from, to, patch)`, `setCustomMask`.
- `apps/desktop`: Shape grid and SVG import (new `CameraShapeRow.tsx`), Switch in section (new
  `SwitchBlock.tsx`), path overlay on the preview (new `PathOverlay.tsx`, one line in `Preview.tsx`),
  Float label, CSS in a new `camera-extras.css`.
- `crates/capture`: `LAYOUTS` gains `float`, `Hotkey::Layout(5)` (Ctrl+Shift+5).

## Not checked by this design

Real Ctrl+Shift+5 during a recording (owner check). Arbitrary SVG files from the web: the importer takes the
common path commands; a file it cannot read gives the one-line error.
