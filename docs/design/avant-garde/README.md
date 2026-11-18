# Marz Recorder: avant-garde design (Editorial Brutalism)

Binding rules, components, copy and checklists: `DESIGN-SYSTEM.md`. Tokens: `tokens.css`. Icons: `icons.md`. Guard: `pnpm design:check`.

Status: approved direction (2026-11-16). Reference only: the `.dc.html` files are design mockups made in Claude Design, not production code. Rebuild them in `apps/desktop` (React/TS).

Live canvas (needs Mauricio's Claude login): https://claude.ai/artifact/8dm8fSSthhMgZwNCHLrFSq

## Concept

A printed contact sheet and film slate. Time is the architecture: the editor is a ruled timecode ledger and the only loud object is the playhead number. Full reasoning: `concept.md`.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0B0B0A` | Page background, text on paper |
| `--paper` | `#ECEAE4` | Text on ink, inspector and Home hero panels (inverted) |
| `--accent` | `#D4FF3A` | ONE accent: zoom blocks, primary actions, active state. Placeholder, change in one place |
| `--rec` | `#E0352B` | Reserved for recording and cuts only. Text on it is white |
| `--faint` | `#9A988F` | Secondary text on ink (4.5:1+) |
| `--line` | `rgba(236,234,228,.24)` | Ruled lines |

Rules: no border radius, no shadows, no transitions on state change, no gradients except the hatching for cuts and the grid lines.

## Type

- Display (timecode, big headings, project names, inspector values): Familjen Grotesk 700, letter-spacing -0.05em, line-height 0.8 for giant sizes. Hero timecode 250px.
- Labels, captions, buttons, hotkeys: Martian Mono 400/500, 11px, uppercase, letter-spacing 0.04em.
- ASSET NEEDED (optional, paid, not included): ABC Monument Grotesk and ABC Diatype Semi-Mono from Dinamo. If bought, they replace the two free fonts above.
- Banned as defaults here: Inter, JetBrains Mono, Space Grotesk, system-ui.

## Grid and layout (1440 x 900 artboards)

- 12 columns, 24px outer margin, 116px pitch, column lines visible at 10% opacity behind everything.
- Editor: top strip 44px; giant timecode top-left, partly hidden behind the preview (intentional); vertical tool ledger (icon, label, hotkey, rows 34px, Play row filled with accent); preview 640 x 360 (16:9) at x 420; inspector on paper at x 1068, 348 wide; timeline from y 560, 340 high.
- Timeline: label gutter 216px, tracks start at x 240, 7.3 px per second (160 s = 1168 px). Lanes always visible: Screen (thumbnail strip), Mic (waveform), Zoom, then dashed "Later" lanes (Camera, System audio, Layout, Drawing, Captions). A cut shades every lane in red hatching with a solid red cap on the ruler. Selected block: 2px paper ring with 2px ink gap.
- Block styles: Zoom = solid accent with ink label; Suggested = dashed accent outline; Cut = red hatching. Trim grips on every block.

## Screens

| File | Screen | Milestone |
|---|---|---|
| `Main.dc.html` | Editor, zoom selected (Saving) | M1, build first |
| `Editor-Nothing-Selected.dc.html` | Editor, nothing selected (All changes saved) | M1 |
| `Editor-Cut-Selected.dc.html` | Editor, cut selected, "No usable events file" bar, "Save failed. Retrying..." | M1 |
| `Timeline-Lanes.dc.html` | Timeline with all lanes expanded | M1 |
| `Home.dc.html`, `Home-Empty.dc.html` | Projects list with recover banner, empty state | M1 (approved 2026-11-17) |
| `Recorder-Setup.dc.html`, `Recorder-Recording.dc.html` | Floating bars, region, zoom presets | M1 (approved 2026-11-17) |
| `States.dc.html` | Save status, warning bar, badges, tooltips | M1 |

Every tool has an icon, a label and its hotkey. Hotkeys: Play Space, Add zoom Z, Add cut C, Auto zoom A, Delete Del, Undo Ctrl+Z, Redo Ctrl+Shift+Z, New recording Ctrl+Shift+R. Recorder (only while it is open): Record / stop Ctrl+Shift+R, Pause / resume Ctrl+Shift+P, Mute mic Ctrl+Shift+M, zoom presets Ctrl+1 to Ctrl+9, Zoom out Ctrl+0, Close Esc.

## Placeholders to replace

- The recorded screen in the previews is a fictional billing app called "Fieldnote". Real recordings replace it.
- Project names, durations and counts on Home are sample data.
- Logo is a plain accent square until the brand kit exists.

## How to view a mockup

Open the live canvas link above, or open the `.dc.html` source for exact positions, sizes and copy. They are not runnable on their own.
