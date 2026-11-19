# Background and frame: design

Date: 2026-11-19. Product spec section 11 ("Background and frame: padding, rounded corners, shadow, wallpaper,
gradient or blur"). Owner pre-approved building straight through.

## What the owner sees

The Project panel has a new **Background** block. Pick a background and the screen no longer fills the whole
video: it sits as a framed picture on a backdrop, with a margin around it, rounded corners and a soft shadow.
Preview and both exports show the same picture. Off is the default, so every older project looks unchanged.

Backgrounds (all built from the token colours, drawn by code, no image files):

| Name  | What it is |
|-------|-----------|
| Off   | Today's picture: the screen fills the frame (default). |
| Ink   | Solid ink. |
| Paper | Solid paper. |
| Glow  | Ink with an accent glow rising from the bottom right corner (a radial gradient). |
| Grid  | A generated wallpaper: ink with a paper grid at 8% (12 columns, square cells). |

Options under the picker (shown only when a background is on):

- **Margin** S, M, L: 40, 64, 96 px at a 1080 short side (scaled to the output's short side, so the vertical
  1080 x 1920 picture gets the same margin as 1920 x 1080).
- **Corners** Square, Round: 0 or 16 px at 1080.
- **Shadow** on or off: ink, 50% strength, 40 px blur, 12 px down (at 1080).

## Format (`project.json`, version stays 1)

`edits.background` (optional): `{ "style": "off" | "ink" | "paper" | "glow" | "grid", "padding": "S" | "M" | "L",
"corners": "square" | "round", "shadow": bool }`. Missing = off. Missing or unknown fields read as the defaults
(style off; padding M, corners round, shadow on); the raw object is kept on save, so unknown fields survive.
Reader: `backgroundEdits(p)` in `packages/format/src/background.ts`.

## Drawing (`packages/compositor/src/background.ts`, used by `frameAt` and `drawFrame`)

- `frameAt` takes the layout's screen box as today. With a background on it shrinks the box by the margin and
  fits the screen's full picture (source aspect) inside it: that is the **frame**. `FrameSpec.background` carries
  the style, the frame box, the corner radius and the shadow. With it off `FrameSpec` is exactly as before.
- `drawFrame` paints the backdrop over the whole output, the shadow under the frame, then clips to the rounded
  frame and draws the screen, the drawing strokes inside it; click effects, the cursor and the camera on top, as
  before.
- **Zooms**: the frame stays where it is and the picture zooms inside it (the zoomed area is fitted into the
  frame, clipped to its rounded corners). The backdrop never zooms. The zoom area overlay in the editor maps to
  the whole canvas, so while a zoom is being edited the preview shows the screen without the background.
- **Cursor and clicks**: follow the picture as before (the cursor hides when it leaves the zoomed area). Click
  effects may spill over the frame edge.
- **Drawings**: clipped to the frame (rounded corners included).
- **Camera layouts**: the backdrop covers the whole output; the margin applies inside the layout's screen box.
  Corner bubble: on top, at its corner, over the backdrop. Side column: edge to edge as today, the screen is
  framed in the rest. Camera: covers everything. Switches move the frame with the screen box.
- **Captions**: drawn last as before, positions unchanged.
- **Smart vertical, Follow**: the backdrop covers the 9:16 picture; the aimed window fills the screen box shrunk
  by the margin (the window takes that box's aspect, so no bars). The camera slot stays edge to edge. Captions
  keep the safe area.
- **Smart vertical, Fit**: the 16:9 picture (with its background) letterboxed on ink bars, as today.

## Editor UI

Background block in the Project panel after the Vertical block (DESIGN-SYSTEM.md, Inspector). The UI itself
keeps the no-gradient rule: the picker is the Motion row's segmented control with words, no gradient swatches.
One undo step per change.

## Out of scope

Per-section backgrounds, blur of the screen as a background, user images, scene presets.
