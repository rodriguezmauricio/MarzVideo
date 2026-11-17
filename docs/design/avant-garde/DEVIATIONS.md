# Deviations from the mockups

Where the built editor (`apps/desktop`) differs from `DESIGN-SYSTEM.md` or the `.dc.html` mockups, and why.
Checked 2026-11-16 with 1440 x 900 Edge screenshots of the four M1 editor states against Main, Editor-Nothing-Selected, Editor-Cut-Selected and Timeline-Lanes.

## Left out on purpose (would change behaviour or the project.marz format)

- **"Keep as my own" button (zoom inspector).** Not built: it would turn a live or suggested zoom into a manual one, which is new behaviour. Only "Delete zoom" is shown.
- **Origin row shows "Live, Ctrl+1" as "Live".** A zoom in `project.marz` stores only its origin, not the preset it came from. Showing the hotkey needs a format change.
- **"Click highlight" toggle is read-only.** It shows the stored `edits.clicks.effect` (off in the sample, so it shows off, the mockup shows on). Switching click effects is not built and the compositor does not draw them yet.
- **Click ring on the preview.** The 34px accent ring under the cursor is preview content from click effects, which do not exist yet.
- **Export MP4 button and the "Projects" back link are inert.** Export is build step 6 and Home is a later milestone. Both are drawn as in the mockup; the button has the tooltip "Export comes in a later step".
- **Mic volume in the expanded lanes is display only** (bar + "100%"). Changing the volume is not built.

## Adjusted

- **Suggested and Manual badges on the paper inspector.** Accent text on paper fails contrast and a paper badge on paper is invisible, so on paper: Suggested = 1px dashed ink outline, ink text; Manual = paper fill with a 1px ink border (Live already has one in the mockup).
- **"Later" lane text is 10px, not 9px.** Section 4 says never below 10px; the mockups use 9px.
- **Ledger rows have no side padding.** The mockup's `.win button { padding: 0 }` overrides `.lr2 { padding: 0 10px }`, so the rendered mockup is flush; the build matches the rendered mockup (mockup wins).
- **Cuts are grabbed by the red "Cut" cap on the ruler.** The hatched band across the lanes does not take clicks, so zoom blocks under a cut stay clickable. The cap moves the cut; its ends resize it.
- **Selected cut outline** is clipped at the top and bottom edge of the lanes area (the left and right sides show).
- **Save status has three states.** The store's "unsaved" (a save waiting for the 2 s debounce) is shown as "Saving..." with the hollow square.
- **Auto zoom row is disabled without an events file** (as the spec says). The A hotkey still runs auto zoom, unchanged from before.
- **Warning bar copy** is now the spec sentence. The technical reason the events file failed goes to the console instead of the bar.
- **Inspector values are editable** text fields styled as the 30px display numbers. They accept `mm:ss.t`, plain seconds, or `0.4 s`. Ease is shown and typed in seconds (stored in microseconds as before).
- **Timeline horizontal scrollbar** (thin, line colour) appears only when zoomed in past Fit.
- **Fit scale.** Fit maps the recording to the track width minus 8px (room for the last ruler label), which gives exactly 7.3 px/s for 160 s at 1440 wide, as in the mockup.

## Tokens and assets

- **Two tokens added** to `tokens.css`: `--thumb-line` (#3a3935, thumbnail border, volume track) and `--wave` (#A8A69F, mic bars). Both values were already in section 6 of `DESIGN-SYSTEM.md`, now listed in section 3.
- **Fonts are bundled** in `apps/desktop/src/assets/fonts` (latin and latin-ext woff2 from Google Fonts, SIL Open Font License, licences beside them), declared in `src/styles/fonts.css`. No network needed. Cyrillic and Vietnamese subsets are left out; those characters fall back to the stack in `tokens.css`.

## Window sizes (checked 2026-11-17)

- Rule in `DESIGN-SYSTEM.md` section 5, "Window sizes, editor". Checked in Edge at 1440 x 900, 1536 x 780 (1920 x 1080 at 125%, maximized), 1366 x 680 and 1280 x 680, in four states (nothing selected, zoom selected, cut selected, lanes expanded), with and without the warning bar. Nothing clipped or overlapping.
- 1440 x 900 is unchanged: screenshots before and after differ in at most 2 pixels by 1/255 in the timecode glyph edges, the same noise the old build shows against itself.
- The hero timecode shrinks with the main area height (135px at 1536 x 780, 118px at 680 tall), so at those sizes it no longer reaches under the preview. Seven 34px ledger rows under a 250px timecode need 491px; there is not that much room.
- At 680 tall the timeline shows the four working lanes and one Later lane (Camera); the other Later lanes are cut off from the bottom. At heights between the checked ones a Later lane can show partly.
- At 1280 wide the preview caption "Full frame. Select a zoom or cut..." wraps to two lines (there is room under the preview).
- The 12-column grid lines keep the 116px pitch from the left margin, so on windows wider than 1440 the last strip of the window has no grid line, and the inspector edge is not on a column line at other widths.

## Home (checked 2026-11-17)

- Checked in Edge at 1440 x 900 against `Home.dc.html` and `Home-Empty.dc.html` (fake rows behind `?home=fake` and `?home=empty`), plus 1536 x 780 and 1280 x 680. Hero, banner, header, rows and the empty state sit on the mockup positions (hero buttons at x 916, y 246; rows from y 410; empty buttons at 24, 540; tracks at 760, 520).
- **Buttons have side padding.** In the mockups `.win button { padding: 0 }` beats `.fb { padding: 0 16px }`, so the dot icon, the hotkey and the Recover and Discard labels touch the button edges. The build keeps the 16px padding the `.fb` class asks for.
- **Thumbnails are a real frame** of `screen.mp4` (0.5 s in), not the drawn app placeholders of the mockup. In the browser fake rows show the demo sample.
- **Settings is inert** (no settings in M1), drawn as in the mockup with the tooltip "Settings come in a later version", like Export was before it was built.
- **New recording does nothing yet.** The recorder is Task 12; the button and Ctrl+Shift+R call a stub command.
- **Discard asks in the banner** (bold question, Discard and Keep) instead of a dialog, so no new component was needed. Added to section 6.
- **A recording that needs recovery is only a banner**, not also a row, as in the mockup (the interrupted recording is not in the list).
- At 1280 x 680 the empty state's tracks preview runs past the bottom; the screen scrolls.

## Recorder setup (checked 2026-11-17)

Checked in Edge at 1440 x 900 (`recorder.html?fake&bar`, the mockup's desktop as backdrop) against `Recorder-Setup.dc.html`. Region, handles, size chip, presets, bar (180, 704, 1080 x 70) and the "never captured" chip land on the mockup's pixels. 0.72% of pixels differ; besides the items below that is glyph anti-aliasing (bundled fonts against the mockup's web fonts).

- **Mode picker is wider** (793 px, mockup 499): Window carries the dashed "Not in this version" tag and a fifth "Close / Esc" segment was added. Both are in DESIGN-SYSTEM.md section 6.
- **Preset tags end in a 12px close icon** (removes the preset), as added to section 6. The mockup has none.
- **The mic picker opens the system list** (a native select under the 1px line box). Its open list is drawn by Windows, not in the design. Long names cut at 240 px with an ellipsis, so the bar can be wider than 1080 (1189 on this PC with the Intel array mic).
- **"Starting..." is faint on the rec fill,** as section 6 says; that contrast is low (it is a short disabled state).
- **Bar and overlay transparency:** the parts of the bar window around the bar and chip are transparent but still take clicks (small strip under the bar).

## Recorder while recording (checked 2026-11-17)

Checked in Edge at 1440 x 900 (`recorder.html?fake&bar&state=recording`, the mockup's desktop as backdrop, Terminal output hovered) against `Recorder-Recording.dc.html`. Region border, dimming, live preset, top-left chip (240, 96, 457 x 28), bar top (716), button tops (727) and the "never captured" chip (513, 786) land on the mockup's pixels; the tooltip sits 37 px above its button, as in the mockup (690). 1.56% of pixels differ (0.86% before the labels and icons of fix round 1), from the items below and glyph anti-aliasing.

- **Bar is wider than the mockup** (879 px there). In the mockup `.win button { border: 0; padding: 0 }` beats `.pb` and `.fb`, so Pause and Mute lose their 1px line border and Mute and Stop lose their side padding (STOP touches the button edge). The build keeps the border and padding the classes ask for, as on Home. Mute is 150 px (mockup 120), Stop 87 px (mockup 55).
- **Labels and icons on every button** (fix round 1, CLAUDE.md: every tool has an icon, a label and its hotkey): Pause shows "Pause"/"Resume" next to its icon (mockup: a 44 px icon-only square) and each preset button starts with the zoomadd icon. With two presets the bar is 1048 px (left edge 196 at 1440 x 900); the button tops and the chips stay on the mockup positions. Hotkeys stay in the tooltips, as in the mockup.
- **Paused, muted, tooltips for every button, Full screen chip text, no-mic Mute, warnings and failures** are not in the mockup; added to DESIGN-SYSTEM.md section 6 first.
- **`dim-rec` token** (`rgba(5,5,4,.4)`, the mockup's value) added to `tokens.css` for the dimming while recording; setup keeps `dim`.
- **Tooltip room:** the bar window grows 28 px upward while the pointer is over it, so a tooltip fits; the bar does not move. While the pointer is elsewhere the window is the bar's size, so nothing above the bar takes clicks.

