# Marz Recorder design system: Editorial Brutalism

This is the contract for how the app looks. It is not a suggestion. If the app and this file disagree, the app is wrong. If this file and a mockup disagree, the mockup in `Main.dc.html` wins and this file gets fixed.

Read order: this file, then `tokens.css`, then the mockup for the screen you are building. Run `pnpm design:check` before every commit.

## 1. Idea in one line

A printed contact sheet and a film slate. Time is the architecture. The editor is a ruled timecode ledger and the only loud object is the playhead number. Calm comes from ink, paper, ruled lines and one accent colour, never from soft shadows or rounded cards.

## 2. Things that are always wrong here (drift traps)

If you catch yourself doing one of these, stop and re-read this file.

1. Rounded corners. `border-radius` is 0 everywhere. The only circle in the app is the click-highlight ring drawn on the preview.
2. Shadows, glows, blur, glass, frosted panels, backdrop filters. The only `box-shadow` allowed is the 999px dimming trick around the zoom area and the 2px selection ring on a timeline block.
3. Gradients. Only three exist: the 12-column grid lines, the red cut hatching, and the hatched red square on the Home recover banner (the same hatching). No gradient fills, no gradient text.
4. A second accent. Blue, purple, green, orange are forbidden. Recording red is not an accent, it is reserved (see section 3).
5. Tailwind default palette or utilities (`bg-slate-900`, `rounded-lg`, `shadow-md`, `ring-2`). The theme in `tokens.css` deletes them on purpose. Do not re-enable them.
6. Inter, Roboto, system-ui, Arial, Helvetica, JetBrains Mono, Space Grotesk, IBM Plex, DM Sans or any other default font. Fonts are Familjen Grotesk and Martian Mono only.
7. Hex colours outside `tokens.css`. Use variables or the Tailwind names (`bg-ink`, `text-paper`, `bg-accent`, `bg-rec`).
8. Transitions and animations on UI state. Hover, focus, selection and panel changes are instant. Playback itself is the only thing that moves.
9. Centered body layouts, floating cards, pill buttons, icon-only toolbars without labels, tooltips as the only label.
10. Emoji, stock photos, illustrations, lorem ipsum, "Get started" style marketing copy.
11. Title Case, exclamation marks, "successfully", "please", "oops".
12. Adding features not in the milestone scope: camera motion paths, shape morph, custom or SVG masks, drawing tools, chat with the AI, caption styles beyond the two below. Only the greyed dashed "Later" lanes exist for them. The camera is in with its layouts (2026-11-19): four masks, a border, four layout scenes on the Layout lane, exactly as written in "Camera layouts" below, nothing more. Since M2 (2026-11-19) captions and the AI pass are in, exactly as written in "AI pass" and "Captions" below, nothing more.
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
  - The main area shrinks first. Ledger rows stay 34 and the ledger keeps 12 above the timeline edge. The hero timecode, the playline and the preview top move up together with one scale (1 at a 525px main area since the ledger has eight rows; at 1440 x 900 that is 0.96, about 239px; see DEVIATIONS.md): timecode size 250 x scale (about 135 at 1536 x 780, 118 at 1366 x 680), still display 700, line-height 0.8. The playline stays 34 above the ledger. The 16:9 preview fits what is left. At small heights the timecode no longer reaches under the preview; that is accepted.
  - At 1440 x 900 and above every value is the designed one.

## 6. Components

### Top strip (44px, every app screen)
Left: back link "Projects" (underlined, arrow icon), "/", project title (mono 500), save status. Right: "1920 x 1080 / 60 fps" in faint, Export MP4 button (accent fill, ink text, 30px high, label then download icon). Border-bottom 1px line.

### Save status (three states, left of the strip)
- All changes saved: 8px accent square + faint text.
- Saving...: 8px square with 1px accent outline (hollow) + faint text.
- Save failed. Retrying...: paper block, ink text, 500 weight, alert icon. Not red.
- "Projects" saves first. While the save fails the editor stays open with "Save failed. Retrying..." (click "Projects" again once it reads "All changes saved"). Closing the window also saves first; it closes after 3 s at most.

### Warning bar (24px, under the strip, shifts content down 24px)
Paper background, ink text, alert icon, bold lead sentence. Text: "No usable events file. Click effects and auto zoom are unavailable. You can still add zooms and cuts by hand." Auto zoom row and Click highlight toggle become faint/disabled.

### Export (Export MP4 button in the top strip, hotkey Ctrl+E)
- Idle: the strip button above. Tooltip "Export MP4 / Ctrl+E", right-aligned to the button.
- Preset panel: a click or Ctrl+E drops a paper panel straight under the button: top on the strip's bottom line, right edge on the button's right edge, at least 348 wide (the inspector width) and wider when a row needs it (rows never wrap; the "Instagram and TikTok" row needs 414), 24 between label and size. Paper fill, ink text, 1px ink rule between rows, no shadow. Outer border 1px paper (the floating-bar rule), so a highlighted ink row stays framed on the ink page. Two rows, 34px high, 12px side padding. Left: icon 15px + label (mono 500). Right: the size in `faint-on-paper`, then an 8px marker slot.
  - "YouTube" (`fullscreen` icon) / "1920 x 1080, 60 fps". The fps is the one the export uses: the source fps, at most 60 ("1920 x 1080, 30 fps" for a 30 fps recording).
  - "Instagram and TikTok" (`portrait` icon) / "1080 x 1920, 30 fps".
  - The last used row (YouTube the first time) has the 8px accent square with a 1px ink outline in its marker slot (on paper the accent alone is too light).
  - Hover or arrow-key highlight: the row inverts to ink background, paper text, `faint` size. Enter picks the highlighted row (the last used one when the panel opens), a click picks the clicked row. Esc, Ctrl+E or a click outside closes the panel.
- Save dialog: the native Windows save dialog (drawn by Windows), titled "Export MP4", starting in the projects folder's `Exports` folder (made on first export), file name `<project name> YouTube.mp4` or `<project name> Vertical.mp4`, type MP4. Cancel in the dialog changes nothing. Windows asks before replacing a file. A name typed with another extension ("clip.mov") opens the dialog again on "clip.mp4", so that question is always asked.
- Exporting: the button's place shows "Exporting 42%" (mono 500, paper, whole percent, width fixed to "Exporting 100%") and a Cancel button right of it: 30px high, 1px paper border, paper text, `close` icon + "Cancel", tooltip "Cancel export. Nothing is written" (no hotkey on purpose: a stray key must not throw away a long export). A 2px accent line runs along the bottom of the top strip from the left edge, its width the progress, over the 1px line. Editing stays possible; the export uses the project as it was when the preset was picked. Ctrl+E does nothing and the "Projects" link is faint with the tooltip "Cancel or wait for the export first" while it runs.
- Done: the save status slot shows the 8px accent square + "Exported." (faint) + "Show in folder" (paper, underlined, like the back link), which opens Explorer with the file selected. It stays until the next edit or the next export, then the save status returns.
- Cancelled: back to idle. No message; no file is written and an existing file with that name is untouched.
- Failed: the Warning bar "Export failed. <reason>. Your project is unchanged." It replaces any other warning until the next export starts. Reasons: "FFmpeg is missing. Install it or set MARZ_FFMPEG", "This folder cannot be written to. Pick another folder", "Pick a folder outside the project" (the save dialog picked a folder inside a `.marz` project, where the export could replace a raw track), "This computer cannot encode H.264 video", "FFmpeg stopped with an error", "The video could not be encoded" (anything else in the webview). The details go to the console.
- Empty output (every part is cut): the button has no fill, a 1px line border and faint text and does nothing; tooltip "Nothing left to export. Every part is cut.". Ctrl+E does nothing.

### Playhead timecode (editor hero)
`mm:ss` in display 250px, paper, at left 18px top 30px. It sits BEHIND the preview and is partly covered on purpose. Under it a faint line: "Playhead 01:03.0 / Length 02:40.0".

### Tool ledger (vertical list, x 24 to 376)
Eight rows, 34px each (nine with a camera), 1px line between, bottom line at the end. Each row: icon 15px + label left, hotkey right in faint. Order and hotkeys: Play / pause (Space), Add zoom (Z), Add cut (C), Add layout (L, `layout` icon, only in projects with a camera), Auto zoom (A), Edit with AI (Shift+E, `ai` icon), Delete (Del), Undo (Ctrl+Z), Redo (Ctrl+Shift+Z). Edit with AI is faint while a pass runs (tooltip "AI edit is running"). Play row is filled accent with ink text. Disabled rows are faint (Delete with nothing selected, Auto zoom without an events file). Hover: invert the row to paper background and ink text, no transition. In the expanded-lanes screen the ledger becomes a horizontal row 36px high across the full width, same content.

### Preview frame
16:9, 640 x 360 at x 420 (391 x 220 when lanes are expanded). 1px paper border, no radius, no shadow.
Camera (recordings with a camera): drawn on the picture by the layout in force (see "Camera layouts"); by default the corner bubble in the chosen corner, width a share of the output (S 16%, M 22% default, L 30%), gap to the edges 3% of the output width, camera aspect kept, mirrored by default, 1px paper border at output scale. Zooms move the screen only, inside the screen's box; the camera stays put. Export draws the same. While a zoom is being edited the preview shows the screen only (no camera), so the zoom area matches the frame. Caption below in faint: "Press Play to see the result" (zoom selected), "Press Play to see the switch" (layout selected), "Full frame. Select a zoom or cut on the timeline to edit it" (nothing selected), "This part is skipped when you export" (cut selected).

### Zoom area (on the preview, when a zoom is selected)
2px dashed accent rectangle, locked 16:9, with `box-shadow: 0 0 0 999px var(--dim)` to dim the outside, and four 12px square handles at the corners (paper fill, 2px ink border). A click ring (34px circle, 2px accent) sits under the cursor at the click point.

### Cut state on the preview
Red hatching overlay (135deg, rec 40% / 12%, 8px/16px), 3px inset red border, and a solid red chip top-left: "Cut 01:32 to 01:44. Removed from export" in white.

### Inspector (paper panel, x 1068, width 348, full height of the main area)
Inverted: paper background, ink text, ink 1px rules. Padding 20px. Title in display 54px. Content by selection:
- Zoom: title "Zoom 2" + origin badge. 2 x 2 grid of cells (Start, End, Ease in, Ease out; label 10px faint-on-paper, value display 30px). Motion row with a two-option segmented control (selected = ink fill, paper text): Smooth, Linear. Origin row: "Live, Ctrl+1". Buttons: "Keep as my own" (ink fill, paper text, 42px), "Delete zoom" (1px ink border, trash icon).
- Cut: title "Cut" + red "Removed" badge. Cells: Start, End. Row: Length "12.0 s". One paragraph: "The original recording is untouched. Delete the cut to bring this part back." Button: "Delete cut" (1px ink border).
- Nothing selected: title "Project", subtitle "Nothing selected" in faint-on-paper. Toggles: "Hide cursor" (off), "Click highlight" (on). Hint: "Select a zoom or a cut on the timeline to edit it."
- Camera block (Project panel, only when the recording has a camera), under the toggles, after a 1px ink rule: section label "Camera" (mono, faint-on-paper), toggles "Show camera" (on) and "Mirror" (on), a Corner row (four 22px squares in a 2 x 2, 1px ink border, 2px gap, selected = ink fill; each has the corner name as its accessible label and tooltip), a Size row with the Motion row's segmented control: S, M, L (16%, 22%, 30% of the output width), a Shape row (same segmented control: Plain, Round, Circle, Square), a Border row (same: None, Thin, Thick) and a Colour row (three 22px squares in a row, 2px gap, filled paper, ink and accent, 1px ink border; selected = a 2px ink square inset 4px inside it; names "Paper", "Ink", "Accent" as accessible label and tooltip; hidden when Border is None). Every change is one undo step.
- Layout selected: title "Layout" + origin badge (Live or Manual). Cells: Start, End. A Layout row: label "Layout" over a 2 x 2 grid of the Motion row's segmented buttons (Corner, Side, Camera, Screen; selected = ink fill, paper text), each 34px high. Row: Length "4.0 s". One paragraph: "Between layouts the camera sits in its corner. Switches take 0.4 s." Button: "Delete layout" (1px ink border, trash icon).
- AI edit block (Project panel, always, last), after a 1px ink rule: section label "AI edit" (mono, faint-on-paper). Pace row (48px): label "Pace", a slider (track 1px ink line, 12px square ink knob, no fill, 80 to 600 ms in 10 ms steps), "Tight" left and "Loose" right of the track in 10px faint-on-paper, the value right in mono 500 ("0.3 s"). Five toggle rows, 34px each (the Hide cursor toggle): Silences, Ums, Mistakes, AI zooms, Captions. Last line, 10px faint-on-paper: "Last run: pt, en. Claude sonnet." or "Not run yet. Press Shift+E to edit with AI.". Moving the slider or a toggle re-applies the AI edits at once (one undo step each) without calling the AI again. When the Project panel is taller than the inspector it scrolls inside the panel.
- AI edit selected (a cut or zoom with origin AI): the Cut or Zoom panel as above with the AI badge; the cut paragraph gains one line first: "Cut by AI: <reason>. Delete it and the next AI pass leaves this part alone." (reasons "Silence", "Um", "Mistake").
- Caption word selected: title "Caption", subtitle the word's time ("01:03.2") in faint-on-paper. Text cell (68px): label "Text" (10px faint-on-paper), a text field in display 30px, ink text, 1px ink underline, no box. Enter or leaving the field applies (one undo step), Esc restores. Toggle row "Hide from captions". When the text differs from what was said, a button "Use the spoken word" (1px ink border, 42px) removes the fix. One paragraph: "Fixes the caption only. The audio and the transcript stay as they are."
Toggle: 34 x 18, 1px border, 12px square knob. On = accent (on ink) or ink fill with accent knob (on paper).

### Badges (squares, 22px high, mono 500)
Live = accent fill, ink text. Suggested = 1px dashed accent outline, accent text, no fill. Manual = paper fill, ink text. AI = ink fill, accent text (on the paper inspector). Cut/Removed = rec fill, white text.

### Timeline (y 560 to 900 at 1440 x 900; 2px paper top border)
- Header 34px: "Timeline" left; right: "Zoom" label, "-", "+", "Fit" (22px high boxes with 1px line), and "Hide lanes"/"Show lanes" (accent outline and accent text, layers icon).
- Ruler 28px: tick every 5 s (6px), labelled tick every 10 s (11px, white line, "mm:ss" 10px faint at top).
- Rows: label gutter 216px (mono, faint, left aligned, 1px right rule), track from x 240, width 1176px, 7.3 px per second at Fit. Row heights at Fit: Screen 52, Mic 44, Zoom 44, then five Later lanes 22 each. Expanded: Screen 80, Mic 72 (with volume slider and "80%"), Zoom 56, Later 44 each.
- Lanes always visible, in this order: Screen (thumbnail strip, 16:9 thumbs, 1px #3a3935 border), Mic (waveform, bars 2px wide every 4px, colour #A8A69F), Zoom, Camera, System audio, Layout, Drawing, Captions. The last five are Later lanes: dashed 1px outline in `later`, label in faint, text "Later". They are never interactive. Exceptions: a recording made with "Computer sound" on shows its waveform in the System audio lane (same place and height, label in paper, waveform like the Mic lane); a recording made with the camera on shows camera thumbnails in the Camera lane (the Screen lane's thumbnail strip at the Later lane's height, 22px, 44px expanded; label in paper). Without them those lanes stay Later lanes. A recording with a camera also makes the Layout lane real (see "Layout lane" below). A project with a transcript shows its words in the Captions lane (see "Captions lane" below); without one Captions stays a Later lane.
- Blocks (Zoom row, 6px from top, height row-12, labels 10px mono 500): Zoom = solid accent, ink label ("Zoom 1"). Suggested = 1px dashed accent border, 9% accent fill is NOT used (transparent), accent label. Every block has 3px grips on both ends (ink on accent, accent on dashed). Selected = `box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--paper)` and 5px grips.
- Cut: a hatched band (135deg, rec 50% / 14%, 5px/10px, 1px red left and right borders) across EVERY lane from the ruler down, plus a solid red cap on the ruler row labelled "Cut" in white. Selected cut = 2px paper outline with 1px offset.
- Playhead: 2px paper line over all lanes with a 14 x 11 paper triangle at the top (pointing down).
- AI edits (M2): an AI zoom block and an AI cut cap carry the AI tag after their label: "AI" in mono 500 10px, 1px border in the label's colour (ink on an accent block, white on the red cap), 14px high, 0 3px padding, 4px after the label. AI cut caps are labelled by reason instead of "Cut": "Silence", "Um" (pure and context fillers), "Mistake"; manual cuts keep "Cut". A cap or block too narrow for its label shows no label and no tag (the inspector still names it).
- Footer 28px: "3 zooms / 1 cut / 2 suggested" left, with " / 6 by AI" added when AI edits exist ("8 zooms / 23 cuts / 6 by AI"), lock icon + "Dashed lanes are reserved for a later version" right, faint.

### AI pass (M2)
Runs after Stop (the editor opens with `?ai=1`) and from the Edit with AI row (Shift+E). Editing stays possible while it runs.
- Status line, in the save status slot (replaces it while shown): "Transcribing 40%" and "Editing with AI" with the hollow 8px accent square of "Saving..." and faint text; then "AI edit: 23 cuts, 6 zooms, captions. Ctrl+Z undoes it" with the solid 8px accent square and faint text, until the next edit. A pass that finds no words: "No speech found. Nothing was cut." (solid square, faint). The parts after "AI edit:" name only what happened ("AI edit: 4 cuts. Ctrl+Z undoes it").
- Failures use the Warning bar, the rest of the pass still applies: "Whisper is missing. Install it or set MARZ_WHISPER. Only silences were cut.", "Claude Code is not installed. Mistakes and AI zooms were skipped.", "Claude Code is not signed in. Open it once and sign in.", "Claude usage limit reached. Rerun later.", "AI result looked wrong. Mistakes and AI zooms were skipped.", "Transcription failed. Only silences were cut.", "The AI step failed. Mistakes and AI zooms were skipped.".
- Model download ask (first pass without the transcription model): the Warning bar with the bold sentence "Download the transcription model (550 MB)?" and two text buttons after it, mono 500, ink, underlined like "Show in folder": "Download" and "Not now". While it downloads: "Downloading the transcription model 40%". "Not now" runs the pass without transcription (silences from the mic level only).

### Camera layouts (projects with a camera)
Layouts are scenes on the Layout lane. Between scenes the corner bubble shows. Drawn by the compositor in preview and export.
- Corner bubble: the Camera block's corner and size. Masks: Plain (camera aspect, no radius), Round (camera aspect, corner radius 18% of the short side), Circle and Square (a square 75% of the bubble width, centre cropped). The mask's round corners are video content, not UI chrome.
- Side column: the camera full height and 9:16 wide (608 px of a 1920 frame) on the corner's side, centre cropped, no mask; the screen is fitted into the rest of the frame (ink around it).
- Camera: the camera fills the frame, centre cropped. Screen: no camera.
- Border: None, Thin (1px at 1080), Thick (4px at 1080), inside the camera's box along its mask; colour paper (default), ink or accent from `tokens.css`. No shadow.
- Switch: 0.4 s from the scene boundary, ease in-out cubic. The screen box and camera box move together; a camera that appears grows from the centre of its box (the side column slides in from its edge) and shrinks back the same way.
- Recording: Ctrl+Shift+1 Corner, Ctrl+Shift+2 Side, Ctrl+Shift+3 Camera, Ctrl+Shift+4 Screen. Not drawn on screen while recording (no button, no overlay change). When the editor first opens the take they become Live layout blocks.

### Layout lane (projects with a camera)
The Layout lane becomes a real lane: label "Layout" in paper, same heights (22, expanded 44). One block per scene, the zoom block's geometry (3px from the top and bottom at 22, 6px at 44), labels 10px mono 500: "Corner", "Side", "Camera", "Screen". Manual = paper fill, ink label, ink grips. Live = accent fill, ink label (the Live badge colours). Grips, drag, trim, snapping and the selection ring as zoom blocks. Click selects; L adds a 4 s Side block at the playhead (in the free time after it); Del deletes the selected one. Each change is one undo step.

### Captions lane (M2, projects with a transcript)
The Captions lane becomes a real lane: label "Captions" in paper, same heights (22, expanded 44). Each transcript word is a block from its start to its end: 1px `faint` border, no fill, its text in micro 10px paper inside when the block is wide enough (otherwise no text). Hidden words: 1px dashed `later` border. A fixed word shows the fixed text. Selected word: paper fill, ink text, the block selection ring. Click selects; the playhead moves to the word's start. Words under a cut stay drawn; the cut hatching covers them.

### Captions in the video (M2)
Drawn by the compositor after the frame and the camera, in preview and export, so both match. Font Familjen Grotesk 700, line-height 1.15, text centred. Colours are the tokens (paper, ink, accent), read from `tokens.css` at run time.
- Subtitles (YouTube preset): two lines at most, 32 characters a line. Font size 4.5% of the output height (49px at 1080). Paper text on an ink band hugging the lines (padding 0.35em top and bottom, 0.6em left and right), centred, its bottom 6% of the frame height above the frame bottom.
- Highlight (vertical preset): one line of one to four words, font size 7.5% of the output width (81px at 1080 wide), paper text with the word being said in accent. In the vertical export it sits in the ink area under the letterboxed frame, centred in it, no band. Inside a 16:9 frame (the editor preview) it sits where subtitles sit, at the subtitles size, on the same ink band.
- The preview shows the look of the preset last picked in the export panel (YouTube the first time).
- `.srt` (subtitle lines, output times) is written beside every exported MP4 of a project with a transcript.
- Export panel: a third row under the presets, "Burn captions" (`captions` icon 15px, label mono 500, the paper-panel toggle at the right, 34px). It shows and changes the setting of the highlighted preset: off for YouTube, on for Instagram and TikTok by default, each remembered. Click or B toggles it. Only shown when the project has a transcript.

### Tooltips
Paper fill, ink text, mono 500, padding 7 x 10, no arrow, no shadow. Text: "Add zoom / Z". Appear instantly on hover, offset below or above the control. Every tool shows label and hotkey.

### Recorder: mode picker (floating, top centre, y 28)
Ink with 1px paper border. Four segments 40px high, 1px line between: Full screen, Window, Region, Exact size (icons 16px). Selected = accent fill, ink text.
- In M1 Full screen and Region work. Exact size is Region with a typed width and height. Window is faint (`faint` text, not clickable) with a dashed "Not in this version" tag (1px dashed `later`, 10px, padding 3 x 7, the `.rb-later` style) after its label.
- "Add zoom" segment after Exact size: zoomadd icon, "Add zoom", hotkey "Z" in faint. A click (or Z) arms drawing a zoom preset: the segment turns accent (selected) and the next drag inside the region draws the preset. A click on the dimmed area or Esc disarms it. Faint and not clickable with 9 presets.
- A last segment closes the recorder: close icon, "Close", hotkey "Esc" in faint. Same 40px segment, 1px line before it. Close and Esc show the main window again (Esc first disarms a drawing in progress).
- The overlay takes clicks only on its own controls: the mode picker, the size chip, the region handles and dashed border, the preset tags, handles and dashed borders. Everywhere else, the dimmed area and the inside of the region and presets included, clicks go to the apps under the overlay, before and during the recording. While a drawing is armed ("Region" or "Add zoom") the whole screen takes the next drag.

### Recorder: capture region
2px dashed paper rectangle, 14px square handles at corners and 28 x 8 / 8 x 28 bars at edge midpoints (paper fill, ink border). Outside dimmed at 62% ink. Size chip above top-left: paper fill, ink text, lock icon, "1920 x 1080, 16:9 locked".
- Sizes in the chip are the physical pixels that will be recorded.
- Click "Region" in the mode picker (also when it is already selected) to draw a new region: the next drag anywhere on the screen draws it (any direction), then clicks pass through again. Drag a handle to resize, drag the dashed border (its inner 8px) to move.
- The lock icon in the chip is a button. Locked (default) keeps 16:9 while drawing and resizing; unlocked the chip reads "1000 x 562, free".
- Exact size: the width and height in the chip are two 1px line boxes (ink border on paper, 64px wide, 24px high, mono 500) the person types into; Enter or leaving the box applies it. The region keeps its top-left. Handles are hidden; the region moves by dragging its border.
- Full screen: no dashed rectangle, no handles, no dimming. The chip reads "Full screen, 2880 x 1800" at the monitor's top-left (left 24, top 100).

### Recorder: zoom presets
2px dashed accent rectangles with 7% accent wash, label tag above top-left: accent fill, ink text, number + name + hotkey ("1 Cart total Ctrl+1").
- Click "Add zoom" (or press Z), then drag inside the region (anywhere in Full screen) to draw a preset. Its aspect is locked to the 16:9 output. Up to 9; numbers fill the lowest free slot. Default names "Zoom 1" to "Zoom 9".
- A preset is stored relative to the region (or the monitor in Full screen), so it moves and scales with the region.
- Drag a preset's dashed border to move it (its inside passes clicks through). The selected preset shows the four 12px corner handles of the editor zoom area (paper fill, 2px ink border) and resizes from them.
- Click the name in the tag to rename it: the name becomes a text field inside the tag (ink 1px underline, same font); Enter keeps, Esc cancels. A close icon (12px) at the end of the tag removes the preset. Del removes the selected preset.

### Recorder: bar BEFORE recording (floating, bottom centre, y 704)
Ink, 1px paper border, padding 10 x 12 x 10 x 16. A press on the bar's empty parts (its padding and gaps; the timer too while recording) drags the bar window, cursor `move`; the bar keeps that place (its centre and top edge) for the rest of the app session, also when it switches to the recording bar. It stays on the monitor. In order: mic icon, mic picker (1px line box "Studio mic (USB)" with chevron), level meter (14 bars, 5px wide, accent when lit), divider, Camera (camera icon, picker, toggle; see Camera item below), divider, "Computer sound" toggle (speaker icon, the Hide cursor toggle's style, off by default, remembered with the setup; records what the computer plays into its own track), Hide cursor toggle, Record button (rec fill, white text, dot icon, "Record", hotkey "Ctrl+Shift+R", 48px high). Under it a chip: eye-off icon + "Both bars are never captured in the recording".
- Meter bar heights repeat 8, 11, 14, 17 px; unlit bars are `thumb-line`. Lit bars follow the mic peak on a -60 to 0 dB scale, refreshed every 50 ms.
- The mic picker opens the system list of microphones. With no microphone it reads "No microphone" and the meter stays unlit.
- Starting state: after Record, the Record button reads "Starting..." in faint on the same rec fill with the dot icon, disabled, until the engine reports Recording. No countdown.
- Error line: a paper block attached to the top of the bar, the bar's full width, 24px high, ink text, mono 500, alert icon 13px (the Warning bar treatment). Sentences: "No microphone found. Recording without sound.", "Region is too small. Drag at least 64 x 64.", "FFmpeg is missing. Install it or set MARZ_FFMPEG.". Not red. It goes away when the cause is gone.
- Camera item (replaces the dashed "Not in this version" Camera of earlier builds): camera icon, a picker in the mic picker's 1px line box with chevron ("Integrated Webcam"), then the toggle of Hide cursor. Off by default, remembered with the setup. With no camera: "No camera", toggle disabled. Errors on the error line: "This camera is used by another app. Close it or pick another camera.", "The camera did not start. Pick another camera or turn it off.".
- Note line: the error line's block without the alert icon, for a fact that does not block Record. Only one: "This screen records at 30 fps." while the capture area (the region, or the monitor in Full screen) is larger than 2560 x 1440 pixels; the recording then runs at 30 fps instead of 60. An error line takes its place while there is one.

### Recorder: camera preview (setup only)
While the camera is on during setup, the live camera sits on the overlay where the picture-in-picture will be: bottom-right of the region (the monitor in Full screen), 22% of its width, gap 3% of its width, camera aspect kept, mirrored. 1px paper border, no radius, no shadow. Label tag above its top-left like a zoom preset tag but paper fill, ink text: camera icon + "Camera". It passes clicks through and is not draggable (corner and size are picked in the editor). It is released when Record is pressed, so the engine can open the camera; nothing new shows on the overlay while recording.

### Recorder: hotkeys (registered only while the recorder is open)
Record / stop Ctrl+Shift+R, Pause / resume Ctrl+Shift+P, Mute mic Ctrl+Shift+M, zoom presets Ctrl+1 to Ctrl+9, Zoom out Ctrl+0, camera layouts Ctrl+Shift+1 (Corner), Ctrl+Shift+2 (Side), Ctrl+Shift+3 (Camera), Ctrl+Shift+4 (Screen); the layout keys have no button on the bars. Esc closes the recorder before recording. Each control that has a hotkey shows it next to its label in faint (on accent or rec: in the control's text colour).

### Recorder: bar WHILE recording (floating, bottom centre, y 716)
Rec square (14px) + timer (display 30px), Pause, Mute mic with meter, divider, one button per zoom preset ("1 Cart total", active = accent fill), Zoom out, divider, Stop (rec fill, white). Top-left chip: "Recording this region. Autosaving every few seconds" with red 1px border and square rec indicator. Region border 3px solid rec. Same "never captured" chip below.
- Buttons are 44px high with a 1px line border and 14px side padding; Stop has 16px. Gap 10, padding 10. The chip below sits 4px under the bar.
- Every button has an icon and a label; the hotkeys are in the tooltips. Pause: pause icon + "Pause" (the button keeps the width of "Resume"). Presets: zoomadd icon (16px) + number box + name ("1 Cart total"). Mute: mic icon + "Mute" (the button keeps the width of "Unmute") + meter. Zoom out: zoomout icon + "Zoom out". Stop: stop icon + "Stop".
- The bar and the "Recording" chip appear only once the engine reports Recording; until then the setup bar shows "Starting...". The timer is recording time (pauses excluded), `mm:ss`, `h:mm:ss` from one hour.
- Paused: the Pause button turns accent with the play icon and reads "Resume"; the timer stops.
- Muted: the Mute button turns accent with the mic-off icon and reads "Unmute"; the meter stays in place, unlit.
- Tooltips on hover or focus, above the button (the Tooltips style): "Pause / Ctrl+Shift+P", "Resume / Ctrl+Shift+P", "Mute mic / Ctrl+Shift+M", "Unmute mic / Ctrl+Shift+M", "Zoom to Cart total / Ctrl+1", "Zoom out / Ctrl+0", "Stop and open in the editor / Ctrl+Shift+R" (right-aligned to Stop). Without a mic the Mute button is faint (label "Mute", meter unlit) and its tooltip reads "Recording without a mic".
- Overlay while recording: takes clicks only on the live preset's border and its four corner handles (the 12px handles of the selected preset). Drag the border to move the live zoom, a handle to resize it (16:9 locked); on release the zoom running now and later zooms to that preset take the new frame, zooms that already ended keep theirs. Outside the region dimmed with `dim-rec`; only the live preset is drawn (2px solid accent, no tag). Full screen: the 3px border runs around the monitor and the chip reads "Recording this screen. Autosaving every few seconds" at left 24, top 100.
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
- Honest scope: drawing is shown only as a dashed "Later" lane. Camera, System audio, Layout and Captions too, unless the recording has them (Layout: a camera; Captions: a transcript).

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
