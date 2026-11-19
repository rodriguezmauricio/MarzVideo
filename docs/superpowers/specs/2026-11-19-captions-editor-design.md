# Captions editor: design

Date: 2026-11-19. Product spec section 10 ("Editable captions: fix a word by editing text; style presets;
word-by-word highlight for Reels"). Builds on the M2 AI edit (`2026-11-17-milestone-2-ai-editing-design.md`),
which already has: word fixes and hidden words (`edits.captions.overrides`, `.hidden`), the Captions lane, the
Caption inspector, two looks (subtitles, highlight), burn-in per export, `.srt` beside exports.

## What is new

1. **Split and join captions.** A caption is what is on screen at once (a block). "Split here" starts a new
   caption at the selected word; "Join with previous" glues the caption that starts at the selected word onto the
   one before it. Both are undoable and stored as data, never by touching `transcript.json`.
2. **Caption style per export preset.** Four styles built from the tokens only: Ink band (paper text on an ink
   band), Paper band (ink text on a paper band), Accent band (ink text on an accent band), Plain (paper text with
   a thin ink outline, no band). Plus size S / M / L, position Top / Middle / Bottom, and word highlight on or off.
   Defaults keep today's output: YouTube = Ink band, M, Bottom, highlight off; Instagram and TikTok = Plain, M,
   Bottom, highlight on. Burn-in stays an export choice (off for YouTube, on for vertical by default).
3. **Subtitle files.** `.srt` and `.vtt` beside every export of a project with a transcript, both with the
   edited text and the split/join choices (always the subtitle line building, highlight off).
4. **Transcript panel.** The inspector gets two tabs when the project has a transcript: Edit (today's panels)
   and Transcript (T). Transcript shows the whole talk as captions, one paragraph each, words after cuts faint
   and struck through. Click a word: the playhead jumps there and the word is selected. Double-click (or Enter on
   the selected word): edit it in place. The word being spoken is marked while playing.

## Format (project.marz stays version 1; optional fields only)

`edits.captions` gains two optional fields:

```json
"captions": {
  "overrides": { "w12": "Marz" },
  "hidden": ["w40"],
  "breaks": { "w57": "split", "w80": "join" },
  "styles": {
    "youtube": { "style": "inkBand", "size": "M", "position": "bottom", "highlight": false },
    "vertical": { "style": "plain", "size": "L", "position": "top", "highlight": true }
  }
}
```

- `breaks[wordId]`: `"split"` = a caption always starts at this word; `"join"` = no caption starts at this word
  (pause, sentence end and the block's line limit are ignored there; the line still wraps by its length, so a
  joined subtitle caption can have three lines). Unknown values are ignored and kept on save.
- `styles[presetId]`: missing preset or missing field = the default above. Unknown style names fall back to the
  preset default and are kept on save. Missing `breaks` / `styles` = today's behaviour exactly.
- Old builds ignore both fields (passthrough), so a project edited here still opens in the M2 build.

## Rules

- Line building (`@marz/autoedit` `captionLines`) takes the breaks into account; preview, burn-in, SRT and VTT
  all use it, so they always agree.
- The compositor takes a resolved caption style (colours from tokens.css, size factor, position, band kind) and
  lays out the same way in preview and export.
- Position for the vertical preset: Bottom / Top use the ink letterbox area under / above the picture (today's
  highlight placement); Middle sits over the centre of the picture. For YouTube and for the 16:9 preview: 6 % of
  the frame height from the bottom or top edge, or centred.
- The preview shows the style of the preset picked in the Captions block of the Project panel (it also follows
  the last export preset picked, as today).
- Undo / redo: every text fix, hide, split, join and style change is one undo step.

## UI (written into DESIGN-SYSTEM.md before building)

- Inspector tabs (34 px row at the top of the inspector, only with a transcript): "Edit" and "Transcript",
  segmented-control look, T toggles.
- Caption inspector: two more buttons, "Split here (S)" and "Join with previous (J)", each shown only when it
  applies; the hotkeys work when a word is selected.
- Project panel: a "Captions" block (only with a transcript) before the AI block: For (YouTube / Vertical),
  Style (Ink / Paper / Accent / Plain), Size (S / M / L), Position (Top / Middle / Bottom), "Word highlight" toggle.

## Left out

AI checklist overlay, translation, camera layouts, audio, moving word timing, custom colours or fonts.
