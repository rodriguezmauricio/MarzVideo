# Smart vertical: design

Status: pre-approved overnight by Mauricio (via the master chat, 2026-11-19): "plan and build smart vertical,
he reviews at test time". Product spec section 12: "Auto-reframe to 9:16 using cursor, click and zoom data to aim
the crop; camera moves into its own top or bottom slot instead of being cropped."

## Goal

The vertical export (1080 x 1920, 30 fps) stops being the 16:9 picture with ink bars. It becomes a full 9:16
picture: a crop of the screen that follows the action (cursor rests, clicks, zooms), and, in projects with a
camera, the camera in its own slot above or below the screen. The editor shows it and lets him fix it.

Left out: other aspect ratios, face tracking, AI-chosen framing, a vertical master (`project.output` stays 16:9).

## What he gets

- Top strip: a "Vertical preview" strip button (V). On, the preview shows the vertical picture exactly as the
  export draws it, plus an Aim view beside it: the whole screen with the 9:16 window drawn on it.
- Timeline: a Vertical lane (shown while the vertical preview is on) with Frame blocks. A Frame block holds the
  window at one spot for its time; outside Frame blocks the window follows the action by itself. His blocks win.
  F (or "Hold frame here" in the inspector) adds a 2 s block at the playhead aimed where the window is now. Drag,
  trim, delete, undo and redo like layout blocks. Dragging the window in the Aim view moves the selected block
  (one undo step); with no block selected it adds one at the playhead.
- Inspector, Project panel, Vertical block (always): Framing (Follow, Fit), Camera (Top, Bottom; projects with a
  camera), the "Hold frame here (F)" button.
- Frame selected: title "Frame" + Manual badge, cells Start, End, an Aim row (slider 0 to 100%, left to right)
  and "Delete frame".
- Export panel: under the presets, when "Instagram and TikTok" is highlighted, a toggle row "Follow the action"
  (on by default). Off is today's picture with bars. It is the same setting as Framing in the Vertical block.

## The picture (1080 x 1920)

| Layout in force | Screen box | Camera box |
| --- | --- | --- |
| Corner bubble or Side column (camera shown) | 1080 x 1312, under or over the camera | 1080 x 608 (16:9), at the bottom or top |
| Camera fullscreen | full (covered) | 1080 x 1920, cover cropped |
| Screen only, camera hidden, no camera | 1080 x 1920 | none |

- Camera slot side: `edits.vertical.cameraSlot`; missing = top for a top corner, bottom for a bottom corner.
- The camera box is a plain rectangle (no mask), cover cropped around its centre, mirrored as set, with the
  Camera block's border. Layout switches take 0.4 s, eased, the same scene times as the 16:9 picture
  (`layoutAt` with vertical boxes); a camera that appears grows from the centre of its box.
- The screen box shows a window of the screen with the box's aspect. Its height is the zoom's height at that time
  (the full screen height without a zoom), its vertical position the zoom's, so zooms work as in 16:9. Only the
  window's horizontal centre (the aim, 0 to 1 of the screen width) is free. The window is kept inside the zoom's
  area (the screen without a zoom).
- The cursor is drawn from the event log as in 16:9 (same `frameAt`), so it lands where it was.
- Fit with bars: the 16:9 picture letterboxed (today's export, unchanged).

## The aim

Pure functions in `packages/timeline/src/reframe.ts`, used by preview and export.

1. Automatic path (`autoAim(events, source, durationUs, zooms)`), computed once per project and event log. The
   reference window is the full-height 9:16 window (0.316 of a 16:9 screen wide), times the zoom's height.
   - Points of interest: cursor rests (the cursor stays within 2% for 400 ms or more; point at its start, mean
     x), clicks (down), zoom starts (the zoom's centre), and excursions (the cursor stays outside the window for
     1 s; followed from when it left, arriving 0.5 s later, mean x).
   - Dead zone: a point within 65% of the window's half width from the current aim changes nothing, so the
     window holds still while the action stays in view and while the cursor rests.
   - A point outside it plans a move: an eased 0.7 s move (ease in-out cubic) that arrives when the point
     happens (the file is known in advance, so the move starts before the click). Moves never overlap and are
     at least 1 s apart; a later one starts after that hold and may arrive late (at least 0.4 s long). The
     target is clamped so the window stays inside the screen (and the zoom area at that time).
   - Quick flicks that come back within 1 s and do not rest or click do not move the window.
   - The path starts at the first point (or the first cursor position, or the centre) and is
     `{ x0, moves: [{ startUs, endUs, fromX, toX }] }`.
2. His Frame blocks (`edits.vertical.holds`) win: inside a block the aim is the block's `x`; it eases from the
   automatic aim over the first 0.4 s and back over the last 0.4 s (less for a block shorter than 0.8 s).
3. The final window (`cropRectAt`) clamps the aim into the zoom area at that time.

This is a crop path, not cursor smoothing: the cursor itself is never smoothed (M1 anti-goal holds).

## Captions in the vertical picture

Follow the action keeps captions inside the safe area: 6% from the sides, 13% from the top (250 px), 20% from the
bottom (380 px), where the Reels and TikTok buttons and text sit. The area is also kept inside the screen box,
38 px from its edges, while the box is at least 300 px tall, so captions never cover the camera slot: Bottom sits
just above a bottom camera slot, Top just under a top one, Middle in the middle of the screen box. Sizes are the
vertical preset's (font on the output width: 7.5% with word highlight, 5.5% without; S, M, L as today; lines at
most 94% of the area's width). Fit with bars keeps today's placement in the ink bars.

## Format (project.json stays version 1, all optional)

```json
"edits": {
  "vertical": {
    "framing": "follow",
    "cameraSlot": "bottom",
    "holds": [ { "id": "frame-1", "startUs": 4000000, "endUs": 6000000, "x": 0.42 } ]
  }
}
```

- `framing`: `follow` (default) or `fit`. An unknown value reads as `follow` and is kept on save.
- `cameraSlot`: `top` or `bottom`; missing or unknown = from the camera corner (kept on save).
- `holds`: Frame blocks, source time, `x` is the window's centre as a share of the screen width (0 to 1). Holds
  do not overlap (commands keep them apart; on overlap the later start wins). Entries this build cannot read stay
  in the list.
- Older builds keep the block (edits are passthrough) and ignore it.

## Code

- `packages/format/src/vertical.ts`: `verticalEdits(p)`, `VerticalHold`, defaults, tolerant reading.
- `packages/timeline/src/reframe.ts`: `autoAim`, `aimPathAt`, `aimAt`, `cropRectAt` (TDD).
- `packages/timeline/src/vertical.ts`: `addHold`, `updateHold`, `removeHold`, `setVertical` commands.
- `packages/compositor/src/vertical.ts`: `VERTICAL_SIZE`, `verticalBoxes`, `verticalLayoutAt`, `verticalFrameAt`
  (screen spec + layout), `verticalCaptionArea`. `layoutAt` takes optional static boxes; `captionLayout` takes an
  optional caption area.
- `apps/desktop/src/vertical/`: `drawVertical` (shared by preview and export), the Vertical lane, the Aim view,
  the Vertical block and Frame inspector, F and V hotkeys, `useAimPath`.
- `apps/desktop/src/export`: the vertical preset draws `drawVertical` when Framing is Follow.
- No Rust change: export still encodes frames in the webview and FFmpeg muxes.

## Not checked by this design

How the aim feels on his real takes (owner check). Whether 608 px is the right camera slot height for his face
framing. Reels and TikTok safe areas move between app versions; 13% / 20% is the common guidance today.
