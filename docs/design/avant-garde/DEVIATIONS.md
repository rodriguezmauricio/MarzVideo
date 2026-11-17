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
