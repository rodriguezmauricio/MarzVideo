# Light theme: design

Date: 2026-11-19. Product spec section 14 ("dark-first UI with a light theme option").
Scope: app chrome of Home, Editor and the recorder bars. Video output (compositor, captions, drawings,
camera border, export letterbox) never changes with the theme.

## Idea

Editorial Brutalism stays. Same grid, type, rules and sizes. The light theme swaps the two roles:

| Role | Dark (default) | Light |
|---|---|---|
| Ground (page, strip, timeline, ledger, recorder bars) | ink `#0B0B0A` | paper `#ECEAE4` |
| Text and rules on the ground | paper | ink |
| Inverted panels (inspector, export panel, Home hero) | paper | ink |
| Accent fills that carry ink text (Export MP4, New recording, zoom blocks, active mode, live badge) | accent `#D4FF3A` | accent `#D4FF3A` (unchanged) |
| Accent as text, line, outline or a bare mark on the ground | accent | accent-deep `#4A5C00` |
| Recording and cuts | rec `#E0352B` | rec (unchanged) |

The inspector stays inverted against the ground, so in light it is an ink panel with paper text. That
keeps the contact-sheet contrast between the working surface and the settings panel.

## Accent partner: accent-deep `#4A5C00`

The lime accent on paper is 1.04:1, unreadable. Accent-deep is the same hue, darkened:

- accent-deep on paper: 6.2:1 (passes 4.5:1 text)
- accent-deep on accent: 6.4:1 (so an accent-deep mark next to a lime fill still reads)
- paper text on accent-deep (the knob of an active toggle in light): 6.2:1

Two semantic tokens carry it, so no rule needs a light-only override:

- `--accent-on-ink`: the accent that reads on whatever `--ink` is. Dark: accent. Light: accent-deep.
- `--accent-on-paper`: the accent that reads on whatever `--paper` is. Dark: accent-deep. Light: accent.

Rule: a bare accent (text, dashed outline on the timeline, save square, brand square, meter, volume bar,
active toggle fill, focus ring) uses `--accent-on-ink` on the ground and inside ink chips, `--accent-on-paper`
inside inverted panels. `--accent` stays for fills that carry `--accent-ink` text, and for anything drawn over
the video (zoom area, aim box, recorder region, presets, drawing).

## How the tokens work

`--ink` and `--paper` in the code mean "ground" and "figure". The light theme redefines them under
`:root[data-theme="light"]` in `tokens.css`, together with the derived tokens (faint, line, grid, later,
thumb-line, wave). Existing and future CSS follows the theme without edits. This keeps the diff small and
merges cleanly with parallel work.

Fixed brand tokens never change: `--brand-ink`, `--brand-paper`, `--brand-accent`, `--brand-rec`. Video code
(caption style, camera border colours, drawing colours, export letterbox) reads only these. Colour swatches
that show a video colour (drawing and border swatches) use them too.

Unchanged by the theme: `--accent`, `--accent-ink`, `--rec`, `--rec-ink`, `--dim`, `--dim-rec`.

Light values of the derived tokens:

| Token | Light | Check |
|---|---|---|
| faint | `#4A4944` | 7.5:1 on paper |
| faint-on-paper | `#9A988F` | 6.8:1 on ink |
| line | `rgba(11,11,10,.24)` | |
| line-on-paper | `#ECEAE4` | solid paper on the ink panel |
| grid | `rgba(11,11,10,.10)` | |
| grid-on-paper | `rgba(236,234,228,.12)` | |
| later | `#8A887F` | 2.9:1 on paper (dark: 2.8:1 on ink) |
| thumb-line | `#B5B3AB` | 1.75:1 on paper (dark: 1.7:1 on ink) |
| wave | `#5A5953` | 5.8:1 on paper |

## Behaviour

- Choice: Dark (default), Light, Windows (follows the Windows app mode through `prefers-color-scheme`,
  live when Windows changes).
- Stored in `localStorage` key `marz.theme` (`dark`, `light`, `system`), like the other app preferences. Every
  window (main, recorder bar, recorder overlay) applies it at start and follows changes from other windows
  through the `storage` event.
- `src/theme.ts` resolves the choice and sets `data-theme` on `<html>`. Nothing else reads the theme.
- Toggle: one strip button on Home, left of Settings: contrast icon + "Dark theme", "Light theme" or
  "Windows theme"; a click cycles. Self-contained (`ThemeButton.tsx`) so it can move to the Settings page.

## Guard

`pnpm design:check` gains:

- `theme-in-tokens`: `[data-theme` selectors only in `tokens.css`. Light-only rules elsewhere are banned.
- `video-brand-token`: TS code may not read `--ink`, `--paper`, `--accent`, `--rec` by name; video code reads `--brand-*`.
- Tokens: every themed colour token of the dark `:root` is redefined in the light block, and the app copy of
  `tokens.css` equals the design copy.

## Not in scope

Mockups for light (the dark mockups stay the reference; light is the same layout with swapped roles).
A theme-aware app icon or Windows title bar colour.
