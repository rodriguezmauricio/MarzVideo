# Live hide cursor: design

Date: 2026-11-19. Product spec section 4, "Hide cursor toggle", as a live recorder control. Builds on cursor and
clicks (`2026-11-19-cursor-clicks-design.md`): the Cursor lane's hide blocks already work in preview and export.

## What he gets

While recording, Ctrl+Shift+H (rebindable) or the "Hide cursor" button on the recording bar hides the cursor in
the video from now on; the same key or button shows it again. Nothing changes on his screen: the real cursor stays,
the capture is untouched (`screen.mp4` never has the cursor). When the take first opens in the editor each hidden
stretch is a Cursor lane block with Hide cursor on (id `live-cursor-N`; Cursor blocks have no Live badge, adding one
would change the format) that he can move, trim or delete like any other.

## Behaviour

- Start state: the setup bar's Hide cursor toggle (already there, it writes `edits.cursor.hidden` for the whole
  video). The live button starts in that state, so with the setup toggle on, the live button reads "Show cursor"
  and a press shows the cursor from then on.
- Each press logs one line; a press while paused logs at the pause time (the stretch starts where the take resumes).
- Draw mode, zooms, layouts are independent of it.
- A recording with the cursor in the picture (`source.cursor` "baked") cannot hide it. The recorder never makes
  one today (WGC records without the cursor), but the state carries `cursorBaked`; when true the button is faint and
  its tooltip reads "Cursor is in the picture. It cannot be hidden." and the hotkey does nothing.

## Format

`events.jsonl` gets one new line type (unknown types are already ignored by older builds):

```
{"tUs":4000000,"type":"cursorHidden","hidden":true}
```

`hidden` is the live state from `tUs` on. Only changes are logged.

`project.json`: `edits.cursor.liveImported: true` once the lines were turned into blocks (the field sits in the
passthrough `edits.cursor` object; older builds keep it on save). No other change.

## Import on first open (`importLiveCursor`, `packages/timeline/src/cursor.ts`)

Once per project (`edits.cursor.liveImported`), next to `importLiveLayouts`:
- Walk the `cursorHidden` lines in time order from the start state `edits.cursor.hidden`; repeats are ignored.
- Every stretch where the live state differs from `edits.cursor.hidden` becomes a block `{ id: "live-cursor-N",
  hide: <live state>, clicks: <the video's click effects on/off> }`. A stretch still open at Stop runs to the end.
- Stretches shorter than the 0.1 s block minimum are dropped; blocks go in the free time like "Hide cursor here".
- Baked recordings and takes with no lines are marked imported with no blocks.
- One undo step is not needed: the import happens before the first save, like the other live imports.

## Recorder bar (DESIGN-SYSTEM.md "Recorder: bar WHILE recording")

After Draw, before the divider and Stop: a button `cursor` icon 16px, "Hide cursor" (keeps the width of
"Show cursor"); on = accent fill, "Show cursor". Tooltips: "Hide cursor in the video / Ctrl+Shift+H",
"Show cursor in the video / Ctrl+Shift+H", baked: "Cursor is in the picture. It cannot be hidden."

## Hotkey

Action `hideCursor`, default Ctrl+Shift+H, name "Hide cursor", in `crates/capture/src/hotkeys.rs` ACTIONS and
`apps/desktop/src/settings/hotkeyMap.ts` (21 actions both). No clash with the defaults or the reserved list.
Windows hotkey id 21.

## Tests

Rust: line format, defaults still distinct (21), Hotkey id round trip. TS: event parsing (good and odd lines),
import (start states, repeats, open at stop, short stretches, baked, once only, clicks copied), hotkey map count.
Browser: fake recording bar (`?fake&state=recording`, `&hidden`, `&baked`) at 1440 x 900 and 1280 x 720, editor with
a sample that has `cursorHidden` lines. Windows: a short real take with the hotkey sent by simulated input.
