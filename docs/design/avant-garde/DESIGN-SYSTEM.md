# Marz Recorder design system: Editorial Brutalism

This is the contract for how the app looks. It is not a suggestion. If the app and this file disagree, the app is wrong. If this file and a mockup disagree, the mockup in `Main.dc.html` wins and this file gets fixed.

Read order: this file, then `tokens.css`, then the mockup for the screen you are building. Run `pnpm design:check` before every commit.

## 1. Idea in one line

A printed contact sheet and a film slate. Time is the architecture. The editor is a ruled timecode ledger and the only loud object is the playhead number. Calm comes from ink, paper, ruled lines and one accent colour, never from soft shadows or rounded cards.

## 2. Things that are always wrong here (drift traps)

If you catch yourself doing one of these, stop and re-read this file.

1. Rounded corners. `border-radius` is 0 everywhere. The only circle in the app is the click-highlight ring drawn on the preview.
2. Shadows, glows, blur, glass, frosted panels, backdrop filters. The only `box-shadow` allowed is the 999px dimming trick around the zoom area and the 2px selection ring on a timeline block.
3. Gradients. Only two exist: the 12-column grid lines and the red cut hatching. No gradient fills, no gradient text.
4. A second accent. Blue, purple, green, orange are forbidden. Recording red is not an accent, it is reserved (see section 3).
5. Tailwind default palette or utilities (`bg-slate-900`, `rounded-lg`, `shadow-md`, `ring-2`). The theme in `tokens.css` deletes them on purpose. Do not re-enable them.
6. Inter, Roboto, system-ui, Arial, Helvetica, JetBrains Mono, Space Grotesk, IBM Plex, DM Sans or any other default font. Fonts are Familjen Grotesk and Martian Mono only.
7. Hex colours outside `tokens.css`. Use variables or the Tailwind names (`bg-ink`, `text-paper`, `bg-accent`, `bg-rec`).
8. Transitions and animations on UI state. Hover, focus, selection and panel changes are instant. Playback itself is the only thing that moves.
9. Centered body layouts, floating cards, pill buttons, icon-only toolbars without labels, tooltips as the only label.
10. Emoji, stock photos, illustrations, lorem ipsum, "Get started" style marketing copy.
11. Title Case, exclamation marks, "successfully", "please", "oops".
12. Adding features not in the milestone scope: camera layouts, drawing tools, captions, AI panels. Only the greyed dashed "Later" lanes exist for them.
13. Using red for anything except recording and cuts (error, delete, warning all use ink/paper treatments, see Warning bar).
14. Inventing a new component style because one is missing. Add it to this file first, in the same style, then build it.

## 3. Colour

Colour budget on any screen: ink + paper + faint + ONE accent + red only where recording or a cut exists.

| Token | Hex | Where | Never |
|---|---|---|---|
| ink | `#0B0B0A` | page background, text on paper | |
| paper | `#ECEAE4` | text on ink, inverted panels (inspector, Home hero) | |
| accent | `#D4FF3A` | zoom blocks, Play row, primary action (Export MP4, New recording, Recover), active toggle, selected mode, live badge, status square, dashed zoom area, presets | any decoration; more than ~10% of a screen |
| accent-ink | `#0B0B0A` | text on accent | |
| rec | `#E0352B` | Record button, recording indicator and border, cut blocks, cut hatching, cut cap, "Cut" badge and chip | errors, delete buttons, warnings |
| rec-ink | `#FFFFFF` | text on rec | |
| faint | `#9A988F` | secondary text on ink | primary text |
| faint-on-paper | `#4A4944` | secondary text on paper | |
| line | `rgba(236,234,228,.24)` | ruled lines on ink, 1px | |
| grid | `rgba(236,234,228,.10)` | 12-column lines behind everything | |
| dim | `rgba(11,11,10,.62)` | outside of the zoom area on the preview | |
| dim-rec | `rgba(5,5,4,.4)` | outside the region on the recorder overlay while recording (from `Recorder-Recording.dc.html`) | |
| later | `#5A5953` | dashed outline of "Later" lanes | |
| thumb-line | `#3A3935` | 1px border of timeline thumbnails, mic volume track | |
| wave | `#A8A69F` | mic waveform bars | |

The accent is a placeholder until the brand kit exists. Change it in `tokens.css` only. Because accent text on ink and ink text on accent both pass 4.5:1 for any bright accent, a replacement must stay bright (lightness above ~60%) or `accent-ink` must flip to paper.

Contrast checks that already pass: paper on ink 16:1, faint on ink 6.1:1, ink on accent 15:1, rec-ink on rec 4.7:1, faint-on-paper on paper 7.2:1.

The recorded screen inside the preview (a light app UI) is content, not interface. It is the only place allowed to contain colours outside the table. The mockups use a fictional billing app called "Fieldnote" as a placeholder.

## 4. Typography

Two families only.

- Display: Familjen Grotesk 700. Letter-spacing -0.05em at 130px and above, -0.04em at 54px, -0.02em below. Sentence case (no text-transform). Line-height 0.8 for 130px and above, 0.85 for 54px, 1 below.
- Mono: Martian Mono 400, 500 for emphasis. All UI labels, captions, buttons, hotkeys, timestamps. 11px, line-height 1.3, letter-spacing 0.04em, UPPERCASE via CSS (write copy in sentence case in the source).
- Paid upgrade, only if the files are supplied: ABC Monument Grotesk and ABC Diatype Semi Mono. They replace the two families above in `--font-display` and `--font-mono` and nothing else changes.

Scale (these are the only sizes; do not invent others):

| Name | Size | Family | Used for |
|---|---|---|---|
| hero-time | 250px | display | editor playhead timecode (230px/210px on Home-Empty/Home headings) |
| hero-time-compact | 150px | display | timecode when lanes are expanded |
| page-title | 130px | display | States board title |
| inspector-title | 54px | display | "Zoom 2", "Cut", "Project" (36px when the inspector is compact) |
| value | 30px | display | inspector numeric values, recording timer |
| row-title | 26px | display | project names on Home |
| label | 11px | mono | everything else |
| micro | 10px | mono | ruler numbers, block labels, "Later" tags, preset hotkeys |

Never go below 10px. Hotkeys use the same mono, in faint.

## 5. Grid, spacing and sizes (designed at 1440 x 900)

- 12 columns, 24px outer margin, 116px pitch. Column lines are drawn at 10% opacity behind every screen (`.grid-lines`). Content snaps to column lines.
- Fixed heights: top strip 44, ledger row 34, timeline header 34, ruler 28, timeline footer 28, inspector cell 68, inspector row 48-52.
- Button heights: strip button 30, secondary 34, standard 42, bars 44, record 48, hero 60.
- Borders are 1px (`line`) for ruling, 2px for hero blocks and the timeline top edge (paper), 1px solid paper for floating bars.
- There is no padding scale. Distances come from the grid and the heights above. Use 8, 12, 16, 20, 24 only.
- Window sizes below 1440 x 900: keep the layout, scale the preview and timeline width; never reflow into stacked cards.
- Window sizes, editor (smallest supported: 1280 x 680 inside the window; the app window opens maximized, minimum 1280 x 720):
  - Width: the ledger (352) and the inspector (348) keep their widths and their 24px margins. The preview and the timeline take the rest. With the lanes expanded the 391px preview narrows so it stops 8px short of the inspector, as the normal preview does.
  - Height: the timeline keeps 340 (expanded 540) while the main area above it keeps at least 382 (expanded 256). Below that the timeline gives up height from the bottom, so the Later lanes go first; the ruler, Screen, Mic and Zoom lanes always show (timeline floor 232, expanded 300).
  - The main area shrinks first. Ledger rows stay 34 and the ledger keeps 12 above the timeline edge. The hero timecode, the playline and the preview top move up together with one scale (1 at a 491px main area, the 1440 x 900 value with or without the warning bar): timecode size 250 x scale (about 135 at 1536 x 780, 118 at 1366 x 680), still display 700, line-height 0.8. The playline stays 34 above the ledger. The 16:9 preview fits what is left. At small heights the timecode no longer reaches under the preview; that is accepted.
  - At 1440 x 900 and above every value is the designed one.

## 6. Components

### Top strip (44px, every app screen)
Left: back link "Projects" (underlined, arrow icon), "/", project title (mono 500), save status. Right: "1920 x 1080 / 60 fps" in faint, Export MP4 button (accent fill, ink text, 30px high, label then download icon). Border-bottom 1px line.

### Save status (three states, left of the strip)
- All changes saved: 8px accent square + faint text.
- Saving...: 8px square with 1px accent outline (hollow) + faint text.
- Save failed. Retrying...: paper block, ink text, 500 weight, alert icon. Not red.

### Warning bar (24px, under the strip, shifts content down 24px)
Paper background, ink text, alert icon, bold lead sentence. Text: "No usable events file. Click effects and auto zoom are unavailable. You can still add zooms and cuts by hand." Auto zoom row and Click highlight toggle become faint/disabled.

### Export (Export MP4 button in the top strip, hotkey Ctrl+E)
- Idle: the strip button above. Tooltip "Export MP4 / Ctrl+E", right-aligned to the button.
- Preset panel: a click or Ctrl+E drops a paper panel straight under the button: top on the strip's bottom line, right edge on the button's right edge, at least 348 wide (the inspector width) and wider when a row needs it (rows never wrap; the "Instagram and TikTok" row needs 414), 24 between label and size. Paper fill, ink text, 1px ink rule between rows, no shadow. Outer border 1px paper (the floating-bar rule), so a highlighted ink row stays framed on the ink page. Two rows, 34px high, 12px side padding. Left: icon 15px + label (mono 500). Right: the size in `faint-on-paper`, then an 8px marker slot.
  - "YouTube" (`fullscreen` icon) / "1920 x 1080, 60 fps". The fps is the one the export uses: the source fps, at most 60 ("1920 x 1080, 30 fps" for a 30 fps recording).
  - "Instagram and TikTok" (`portrait` icon) / "1080 x 1920, 30 fps".
  - The last used row (YouTube the first time) has the 8px accent square with a 1px ink outline in its marker slot (on paper the accent alone is too light).
  - Hover or arrow-key highlight: the row inverts to ink background, paper text, `faint` size. Enter picks the highlighted row (the last used one when the panel opens), a click picks the clicked row. Esc, Ctrl+E or a click outside closes the panel.
- Save dialog: the native Windows save dialog (drawn by Windows), titled "Export MP4", starting in the projects folder's `Exports` folder (made on first export), file name `<project name> YouTube.mp4` or `<project name> Vertical.mp4`, type MP4. Cancel in the dialog changes nothing. Windows asks before replacing a file.
- Exporting: the button's place shows "Exporting 42%" (mono 500, paper, whole percent, width fixed to "Exporting 100%") and a Cancel button right of it: 30px high, 1px paper border, paper text, `close` icon + "Cancel", tooltip "Cancel export. Nothing is written" (no hotkey on purpose: a stray key must not throw away a long export). A 2px accent line runs along the bottom of the top strip from the left edge, its width the progress, over the 1px line. Editing stays possible; the export uses the project as it was when the preset was picked. Ctrl+E does nothing and the "Projects" link is faint with the tooltip "Cancel or wait for the export first" while it runs.
- Done: the save status slot shows the 8px accent square + "Exported." (faint) + "Show in folder" (paper, underlined, like the back link), which opens Explorer with the file selected. It stays until the next edit or the next export, then the save status returns.
- Cancelled: back to idle. No message; no file is written and an existing file with that name is untouched.
- Failed: the Warning bar "Export failed. <reason>. Your project is unchanged." It replaces any other warning until the next export starts. Reasons: "FFmpeg is missing. Install it or set MARZ_FFMPEG", "This folder cannot be written to. Pick another folder", "This computer cannot encode H.264 video", "FFmpeg stopped with an error", "The video could not be encoded" (anything else in the webview). The details go to the console.
- Empty output (every part is cut): the button has no fill, a 1px line border and faint text and does nothing; tooltip "Nothing left to export. Every part is cut.". Ctrl+E does nothing.

### Playhead timecode (editor hero)
`mm:ss` in display 250px, paper, at left 18px top 30px. It sits BEHIND the preview and is partly covered on purpose. Under it a faint line: "Playhead 01:03.0 / Length 02:40.0".

### Tool ledger (vertical list, x 24 to 376)
Seven rows, 34px each, 1px line between, bottom line at the end. Each row: icon 15px + label left, hotkey right in faint. Order and hotkeys: Play / pause (Space), Add zoom (Z), Add cut (C), Auto zoom (A), Delete (Del), Undo (Ctrl+Z), Redo (Ctrl+Shift+Z). Play row is filled accent with ink text. Disabled rows are faint (Delete with nothing selected, Auto zoom without an events file). Hover: invert the row to paper background and ink text, no transition. In the expanded-lanes screen the ledger becomes a horizontal row 36px high across the full width, same content.

### Preview frame
16:9, 640 x 360 at x 420 (391 x 220 when lanes are expanded). 1px paper border, no radius, no shadow. Caption below in faint: "Press Play to see the result" (zoom selected), "Full frame. Select a zoom or cut on the timeline to edit it" (nothing selected), "This part is skipped when you export" (cut selected).

### Zoom area (on the preview, when a zoom is selected)
2px dashed accent rectangle, locked 16:9, with `box-shadow: 0 0 0 999px var(--dim)` to dim the outside, and four 12px square handles at the corners (paper fill, 2px ink border). A click ring (34px circle, 2px accent) sits under the cursor at the click point.

### Cut state on the preview
Red hatching overlay (135deg, rec 40% / 12%, 8px/16px), 3px inset red border, and a solid red chip top-left: "Cut 01:32 to 01:44. Removed from export" in white.

### Inspector (paper panel, x 1068, width 348, full height of the main area)
Inverted: paper background, ink text, ink 1px rules. Padding 20px. Title in display 54px. Content by selection:
- Zoom: title "Zoom 2" + origin badge. 2 x 2 grid of cells (Start, End, Ease in, Ease out; label 10px faint-on-paper, value display 30px). Motion row with a two-option segmented control (selected = ink fill, paper text): Smooth, Linear. Origin row: "Live, Ctrl+1". Buttons: "Keep as my own" (ink fill, paper text, 42px), "Delete zoom" (1px ink border, trash icon).
- Cut: title "Cut" + red "Removed" badge. Cells: Start, End. Row: Length "12.0 s". One paragraph: "The original recording is untouched. Delete the cut to bring this part back." Button: "Delete cut" (1px ink border).
- Nothing selected: title "Project", subtitle "Nothing selected" in faint-on-paper. Toggles: "Hide cursor" (off), "Click highlight" (on). Hint: "Select a zoom or a cut on the timeline to edit it."
Toggle: 34 x 18, 1px border, 12px square knob. On = accent (on ink) or ink fill with accent knob (on paper).

### Badges (squares, 22px high, mono 500)
Live = accent fill, ink text. Suggested = 1px dashed accent outline, accent text, no fill. Manual = paper fill, ink text. Cut/Removed = rec fill, white text.

### Timeline (y 560 to 900 at 1440 x 900; 2px paper top border)
- Header 34px: "Timeline" left; right: "Zoom" label, "-", "+", "Fit" (22px high boxes with 1px line), and "Hide lanes"/"Show lanes" (accent outline and accent text, layers icon).
- Ruler 28px: tick every 5 s (6px), labelled tick every 10 s (11px, white line, "mm:ss" 10px faint at top).
- Rows: label gutter 216px (mono, faint, left aligned, 1px right rule), track from x 240, width 1176px, 7.3 px per second at Fit. Row heights at Fit: Screen 52, Mic 44, Zoom 44, then five Later lanes 22 each. Expanded: Screen 80, Mic 72 (with volume slider and "80%"), Zoom 56, Later 44 each.
- Lanes always visible, in this order: Screen (thumbnail strip, 16:9 thumbs, 1px #3a3935 border), Mic (waveform, bars 2px wide every 4px, colour #A8A69F), Zoom, Camera, System audio, Layout, Drawing, Captions. The last five are Later lanes: dashed 1px outline in `later`, label in faint, text "Later". They are never interactive.
- Blocks (Zoom row, 6px from top, height row-12, labels 10px mono 500): Zoom = solid accent, ink label ("Zoom 1"). Suggested = 1px dashed accent border, 9% accent fill is NOT used (transparent), accent label. Every block has 3px grips on both ends (ink on accent, accent on dashed). Selected = `box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--paper)` and 5px grips.
- Cut: a hatched band (135deg, rec 50% / 14%, 5px/10px, 1px red left and right borders) across EVERY lane from the ruler down, plus a solid red cap on the ruler row labelled "Cut" in white. Selected cut = 2px paper outline with 1px offset.
- Playhead: 2px paper line over all lanes with a 14 x 11 paper triangle at the top (pointing down).
- Footer 28px: "3 zooms / 1 cut / 2 suggested" left, lock icon + "Dashed lanes are reserved for a later version" right, faint.

### Tooltips
Paper fill, ink text, mono 500, padding 7 x 10, no arrow, no shadow. Text: "Add zoom / Z". Appear instantly on hover, offset below or above the control. Every tool shows label and hotkey.

### Recorder: mode picker (floating, top centre, y 28)
Ink with 1px paper border. Four segments 40px high, 1px line between: Full screen, Window, Region, Exact size (icons 16px). Selected = accent fill, ink text.
- In M1 Full screen and Region work. Exact size is Region with a typed width and height. Window is faint (`faint` text, not clickable) with the dashed "Not in this version" tag of the Camera item (1px dashed `later`, 10px, padding 3 x 7) after its label.
- A fifth segment closes the recorder: close icon, "Close", hotkey "Esc" in faint. Same 40px segment, 1px line before it. Close and Esc show the main window again.

### Recorder: capture region
2px dashed paper rectangle, 14px square handles at corners and 28 x 8 / 8 x 28 bars at edge midpoints (paper fill, ink border). Outside dimmed at 62% ink. Size chip above top-left: paper fill, ink text, lock icon, "1920 x 1080, 16:9 locked".
- Sizes in the chip are the physical pixels that will be recorded.
- Drag on the dimmed area to draw a new region (any direction). Drag a handle to resize, drag the dashed border to move.
- The lock icon in the chip is a button. Locked (default) keeps 16:9 while drawing and resizing; unlocked the chip reads "1000 x 562, free".
- Exact size: the width and height in the chip are two 1px line boxes (ink border on paper, 64px wide, 24px high, mono 500) the person types into; Enter or leaving the box applies it. The region keeps its top-left. Handles are hidden; the region moves by dragging its border.
- Full screen: no dashed rectangle, no handles, no dimming. The chip reads "Full screen, 2880 x 1800" at the monitor's top-left (left 24, top 100).

### Recorder: zoom presets
2px dashed accent rectangles with 7% accent wash, label tag above top-left: accent fill, ink text, number + name + hotkey ("1 Cart total Ctrl+1").
- Drag inside the region (anywhere in Full screen) to draw a preset. Its aspect is locked to the 16:9 output. Up to 9; numbers fill the lowest free slot. Default names "Zoom 1" to "Zoom 9".
- A preset is stored relative to the region (or the monitor in Full screen), so it moves and scales with the region.
- Drag a preset to move it. The selected preset shows the four 12px corner handles of the editor zoom area (paper fill, 2px ink border) and resizes from them.
- Click the name in the tag to rename it: the name becomes a text field inside the tag (ink 1px underline, same font); Enter keeps, Esc cancels. A close icon (12px) at the end of the tag removes the preset. Del removes the selected preset.

### Recorder: bar BEFORE recording (floating, bottom centre, y 704)
Ink, 1px paper border, padding 10 x 12 x 10 x 16. In order: mic icon, mic picker (1px line box "Studio mic (USB)" with chevron), level meter (14 bars, 5px wide, accent when lit), divider, Camera (faint, dashed tag "Not in this version", disabled toggle), divider, Hide cursor toggle, Record button (rec fill, white text, dot icon, "Record", hotkey "Ctrl+Shift+R", 48px high). Under it a chip: eye-off icon + "Both bars are never captured in the recording".
- Meter bar heights repeat 8, 11, 14, 17 px; unlit bars are `thumb-line`. Lit bars follow the mic peak on a -60 to 0 dB scale, refreshed every 50 ms.
- The mic picker opens the system list of microphones. With no microphone it reads "No microphone" and the meter stays unlit.
- Starting state: after Record, the Record button reads "Starting..." in faint on the same rec fill with the dot icon, disabled, until the engine reports Recording. No countdown.
- Error line: a paper block attached to the top of the bar, the bar's full width, 24px high, ink text, mono 500, alert icon 13px (the Warning bar treatment). Sentences: "No microphone found. Recording without sound.", "Region is too small. Drag at least 64 x 64.", "FFmpeg is missing. Install it or set MARZ_FFMPEG.". Not red. It goes away when the cause is gone.

### Recorder: hotkeys (registered only while the recorder is open)
Record / stop Ctrl+Shift+R, Pause / resume Ctrl+Shift+P, Mute mic Ctrl+Shift+M, zoom presets Ctrl+1 to Ctrl+9, Zoom out Ctrl+0. Esc closes the recorder before recording. Each control that has a hotkey shows it next to its label in faint (on accent or rec: in the control's text colour).

### Recorder: bar WHILE recording (floating, bottom centre, y 716)
Rec square (14px) + timer (display 30px), Pause, Mute mic with meter, divider, one button per zoom preset ("1 Cart total", active = accent fill), Zoom out, divider, Stop (rec fill, white). Top-left chip: "Recording this region. Autosaving every few seconds" with red 1px border and square rec indicator. Region border 3px solid rec. Same "never captured" chip below.
- Buttons are 44px high with a 1px line border and 14px side padding; Stop has 16px. Gap 10, padding 10. The chip below sits 4px under the bar.
- Every button has an icon and a label; the hotkeys are in the tooltips. Pause: pause icon + "Pause" (the button keeps the width of "Resume"). Presets: zoomadd icon (16px) + number box + name ("1 Cart total"). Mute: mic icon + meter. Zoom out: zoomout icon + "Zoom out". Stop: stop icon + "Stop".
- The bar and the "Recording" chip appear only once the engine reports Recording; until then the setup bar shows "Starting...". The timer is recording time (pauses excluded), `mm:ss`, `h:mm:ss` from one hour.
- Paused: the Pause button turns accent with the play icon and reads "Resume"; the timer stops.
- Muted: the Mute button turns accent with the mic-off icon, and "Muted" (the meter's width) replaces the meter.
- Tooltips on hover or focus, above the button (the Tooltips style): "Pause / Ctrl+Shift+P", "Resume / Ctrl+Shift+P", "Mute mic / Ctrl+Shift+M", "Unmute mic / Ctrl+Shift+M", "Zoom to Cart total / Ctrl+1", "Zoom out / Ctrl+0", "Stop and open in the editor / Ctrl+Shift+R" (right-aligned to Stop). Without a mic the Mute button is faint and reads "Recording without a mic".
- Overlay while recording: never takes clicks. Outside the region dimmed with `dim-rec`; only the live preset is drawn (2px solid accent, no tag). Full screen: the 3px border runs around the monitor and the chip reads "Recording this screen. Autosaving every few seconds" at left 24, top 100.
- Warnings while recording ("Hotkey Ctrl+1 is taken by another app", "Microphone disconnected. Recording continues without sound.") use the error line on top of the bar. An engine failure ends the recording and returns to the setup bar with its sentence on the error line. Esc does nothing while recording. Closing the bar or the overlay window (Alt+F4) stops the recording and opens it in the editor.
- A stop that cannot finish the files shows Home with the Warning bar "Recording could not be finished. Recover it below." above the recover banner.

### Home
- Hero: paper block, 276px high, giant display "Record once." (210px), line below, two attached hero buttons: "New recording" (accent, 2px ink border, hotkey Ctrl+Shift+R, 300 x 60) and "Open a project" (2px ink border, 200 x 60).
- Recover banner: ink row, 56px, 2px paper top, hatched red square (24px), "Interrupted: Pricing page walkthrough. The video up to 03:12 is safe.", buttons Recover (accent) and Discard (1px paper border).
- Recent projects: 68px ruled rows, never cards. Columns: index "01" (faint), 96 x 54 thumbnail (1px line), project name display 26px, length mono 500, meta in faint ("3 zooms, 1 cut, edited 2 hours ago"), "Open" with arrow. Table header: "Recent projects" / "Last edited, newest first".
- Empty: giant "Nothing yet." (230px), one sentence, same two buttons, and a ruled preview of the three tracks (Screen, Mic, Clicks) as dashed empty rows saying "Appears here after you record".
- Top strip on Home: 14px accent square + "Marz Recorder" (mono 500) left; "Settings" (gear icon, 1px paper border, 30px high) right.
- Hero buttons: mono 500 at 13px (hotkey 10px), 16px side padding, icon 16px. Banner buttons: 34px high, 16px side padding.
- Discard asks first, inside the same banner: bold "Move <name> to the Recycle Bin?" + faint "You can restore it from there.", buttons Discard (1px paper border) and Keep (1px paper border). Discard never deletes; it moves the folder to the Recycle Bin.
- Errors on Home (a folder that is not a project, a failed recover or discard) use the Warning bar under the strip: "This folder is not a Marz project. Pick a folder that ends in .marz."
- Window sizes, Home: the hero keeps 276px; its buttons stay 24px from the right edge. Banners and the table header keep their heights; the rows scroll under the header. Empty keeps its positions; the tracks preview stays 24px from the right edge and the screen scrolls when it is shorter than the content.

### Icons
24px viewBox, 2px stroke, `stroke-linecap: square`, `stroke-linejoin: miter`, no fill (Play, record dot and stop are solid). Size 12-16px in UI. Never use an icon library with rounded strokes. Path data for every icon is in `icons.md`; copy from there.

## 7. Behaviour

- State changes are instant. No fades, slides, springs, hover transitions.
- Selection: click a block or the preview zoom area. Selected block gets the ring. Inspector shows only the selected item.
- Autosave is always on. The save status square is the only feedback; never show a toast.
- Keyboard: every hotkey in section 6 works. Focus ring is 2px solid accent with 2px offset (ink outline on paper panels). Never remove it.
- Never lose the user's work: raw tracks are never modified (see CLAUDE.md).

## 8. Copy

- Write labels in sentence case in the source; CSS uppercases mono text. Display text stays sentence case.
- Buttons are verbs, 1-3 words: "Export MP4", "New recording", "Recover", "Discard", "Keep as my own".
- Say what happened, then what to do. No "successfully", "please", "oops", exclamation marks, emoji, "simply", "just".
- Numbers: timecodes `mm:ss.t`, sizes `1920 x 1080` (letter x with spaces), frame rate `60 fps`, durations `12.0 s`.
- Honest scope: camera, drawing, captions, system audio, layout are shown only as dashed "Later" lanes.

## 9. Mapping to the code

- `apps/desktop/src/styles/tokens.css` is `docs/design/avant-garde/tokens.css`, imported first in `index.css`.
- `Toolbar.tsx` becomes the vertical tool ledger. `Inspector.tsx` the paper panel. `Timeline.tsx` the ruled ledger with lanes. `Preview.tsx` + `ZoomOverlay.tsx` the frame and dashed zoom area. `Icon.tsx` uses the paths in `icons.md`.
- Component names and state logic stay; only markup and styling change. No behaviour or `project.marz` format changes in a restyle.

## 10. Definition of done for any UI change

1. `pnpm design:check` passes.
2. Screenshot at 1440 x 900 (Edge via Playwright, `channel: "msedge"`) of the same state as the mockup, compared side by side. Positions, sizes, colours and copy match within a few pixels.
3. Every colour, font and size comes from this file. No new values.
4. Every tool shows an icon, a label and its hotkey (tooltip).
5. Screens that are not in the current milestone are not touched.
6. If you had to deviate, the deviation is written down in `docs/design/avant-garde/DEVIATIONS.md` with the reason. Do not deviate silently.

## 11. Files

`README.md` (overview and screen list), `DESIGN-SYSTEM.md` (this file), `tokens.css`, `icons.md`, `concept.md` (why these choices), `*.dc.html` (mockups, reference only), `canvas.json` (canvas index).
