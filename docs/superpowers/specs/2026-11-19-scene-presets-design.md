# Scene presets ("looks") design

Date: 2026-11-19. Product spec sections 7 ("Background and frame ... Saved inside scene presets") and 11
(layouts as presets: camera shape, size, position, border plus the screen's frame). Pre-approved by
Mauricio to build straight through; not merged.

## What it does

- **Save look** (Project panel, Look block): stores the open project's look under a name.
- **Apply** (one row per saved look): writes that look into the open project as one undo step.
- **Delete** (per row): removes the saved look. The projects that used it keep their settings.
- **Settings, Devices, "Look" row**: picks a default look (or None). A take recorded after that choice
  gets it when it first opens in the editor.

## What a look holds

| Part | From the project | Kept from the target project |
| --- | --- | --- |
| Camera | `edits.camera`: `mirror`, the whole `pip` (corner, size, margin, shape, free `x`/`y`), `border`, `customMask`, `transitions` | `visible`, `scenes`, `liveImported`, unknown fields |
| Background and frame | `edits.background`, the whole object, copied as it is (opaque) | nothing |
| Caption style | `edits.captions.styles`, the whole object (YouTube and Vertical) | `overrides`, `hidden`, `breaks` |

- The camera part is saved only when the project has a camera track (the Camera block is hidden
  otherwise, so its values are defaults he never chose). A look without a camera part leaves the
  target's camera alone.
- `edits.background` is copied whole, fields this build does not know included, so background styles
  added by other builds (image, blur, gradient) flow through. A missing background is saved as `null`
  and applying it removes `edits.background` (the screen fills the video).
- Caption styles missing in the project are saved as `{}` and applying them returns both presets to
  their defaults.
- Not part of a look: zooms, cuts, layout scenes, cursor, audio, vertical framing, AI settings. Those
  belong to one take.

## Storage (outside `project.marz`)

- App: `looks.json` in the app config folder (`%APPDATA%/com.marz.recorder`), read and written whole by
  two Tauri commands in `src-tauri/src/looks.rs` (`looks_get`, `looks_set`; temp file then rename;
  a missing or broken file reads as empty).
- Browser: localStorage `marz.looks`, same JSON.
- Shape:

```json
{
  "version": 1,
  "looks": [
    { "name": "Studio", "savedAt": "2026-11-19T18:00:00.000Z",
      "camera": { "mirror": true, "pip": { "corner": "bottomRight", "widthFrac": 0.22, "marginFrac": 0.03, "shape": "circle" },
                  "border": { "width": 3, "color": "accent" } },
      "background": { "style": "glow", "padding": "M", "corners": "round", "shadow": true },
      "captionStyles": { "youtube": { "style": "accentBand" } } }
  ],
  "default": { "name": "Studio", "since": "2026-11-19T18:05:00.000Z" }
}
```

- Names are trimmed, 1 to 40 characters, unique ignoring case. Saving under a name that exists
  replaces that look (the block says "Replaced Studio.").
- Unknown keys in the file and in a look are kept.

## Default look on first open

No format change. A take gets the default look when it opens and all of these hold:

1. a default look is set and still exists;
2. the take was recorded at or after the moment the default was picked (`createdAt >= default.since`),
   so older takes never change look by being opened;
3. its `project.json` has no `edits.camera`, no `edits.background` and no caption styles (a fresh take:
   the recorder never writes them; applying a look writes them, so it happens once).

Like the live layout import, it is part of the opened state (not an undo step) and is saved by the next
autosave. The Look block says "Opened with Studio, the default look." until the next edit.

## Undo

`applyLook(look)` is one `Command`: one History entry. It returns the project itself when nothing
would change (applying the look that is already there adds no undo step).

## UI (DESIGN-SYSTEM.md, Inspector, "Look block")

Project panel, first block (before Cursor), 1px ink rule above, section label "Look":
- one 34px row per saved look: the name (mono 500), "Default" in faint-on-paper when it is the
  default, and on the right text buttons "Apply" and "Delete" (mono 500, ink, underlined, like
  "Import SVG");
- a name field (mono 11px, 1px ink underline, no box, placeholder "Look name") and a 42px button
  "Save look" (1px ink border, `layers` icon 14px); Enter in the field saves;
- last line 10px faint-on-paper: what happened ("Saved Studio.", "Applied Studio.") or "Camera,
  background and caption style. Apply is one undo step."

Settings, Devices section (head note already says "Defaults for new recordings"): a 68px "Look" row
with the mic picker's select (None, then the saved looks).

## Code

- `packages/timeline/src/looks.ts`: `Look` type, `lookOf(project, name, now)`, `applyLook(look)`,
  `isFreshTake(project)`.
- `apps/desktop/src/looks/`: `lookFile.ts` (parse, upsert, remove, default rules: pure),
  `looksApi.ts` (Tauri or localStorage), `LookBlock.tsx`, `defaultLook.ts` (the first-open rule).
- `apps/desktop/src-tauri/src/looks.rs`: `looks_get`, `looks_set`.
- `editorStore.load` applies the default look after the live imports.

## Merge notes

- bg-image-blur: if an image background stores a path inside the project folder, a look copies that
  path as it is; on another take the file may not exist. The background code should already fall back
  when the file is missing.
- Settings Devices section gains one row; onboarding is untouched.
