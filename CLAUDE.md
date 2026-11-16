# Marz Recorder

Windows-first screen recorder + non-destructive editor (Tauri 2, Rust, React/TS). Owner: Mauricio.

## Read first

1. `docs/product-spec.md` — the full product vision.
2. `docs/superpowers/specs/2026-11-15-milestone-1-design.md` — what is being built now (Milestone 1)
   and the `project.marz` format contract.
3. `docs/design/avant-garde/DESIGN-SYSTEM.md` — the approved visual design (Editorial Brutalism). Binding. Also `tokens.css`, `icons.md`, `README.md` (screen list), and the `.dc.html` mockups (reference only). Editor screens are M1; Home and Recorder screens are for later milestones.

## Current status

- The Milestone 1 design is **approved** (2026-11-15). Work happens locally on Windows
  (`C:\Users\conta\source\repos\MarzVideo`); Node, pnpm, FFmpeg, VS C++ tools and Rust are installed.
- **Done:** M1 build order steps 1 to 3 (plan: `docs/superpowers/plans/2026-11-15-m1-format-and-editor.md`).
  `packages/format`, `packages/timeline`, `packages/compositor`, `tools/make-sample`, and the browser
  editor in `apps/desktop` (synced playback, timeline, zoom and cut blocks, auto zoom, undo/redo, autosave).
  Checked in a browser (Edge via Playwright) against the sample project.
- **Done:** editor restyled to the Editorial Brutalism design (2026-11-16). Deviations: `docs/design/avant-garde/DEVIATIONS.md`.
- **Not done:** capture engine, Tauri shell, recorder toolbar, export (steps 4 to 6). No Rust code exists yet.

## Design rules (binding, read DESIGN-SYSTEM.md before touching any UI)

Claude drifts from the design. These rules stop that.

- Look: ink `#0B0B0A` and paper `#ECEAE4`, ONE accent `#D4FF3A`, recording red `#E0352B` only for recording and cuts. All values live in `apps/desktop/src/styles/tokens.css` (copy of `docs/design/avant-garde/tokens.css`). Never write a hex colour elsewhere.
- Fonts: Familjen Grotesk (display) and Martian Mono (labels, 11px, uppercase). No Inter, system-ui, Roboto, Arial.
- No border radius, no shadows, no blur, no gradients (except grid lines and cut hatching), no transitions. Tailwind's default theme is deleted in tokens.css; do not re-enable it.
- Layout: 12-column visible grid, ruled lines, giant timecode, vertical tool ledger with hotkeys, paper-colored inspector, always-visible timeline lanes. Never cards, pills or centered layouts.
- Every tool has an icon, a label and its hotkey. Copy: sentence case source, verbs first, no "successfully", "please", emoji.
- Do not invent styles or sizes. If something is missing, add it to DESIGN-SYSTEM.md in the same style first.
- Before every commit: `pnpm design:check` passes, and a 1440 x 900 screenshot (Edge via Playwright) of each changed state matches its mockup. Write any deviation in `docs/design/avant-garde/DEVIATIONS.md`.
- Stay inside the current milestone. Restyling must not change behavior or the `project.marz` format.

## Run it

```
pnpm install
pnpm sample                          # writes samples/demo.marz (gitignored)
pnpm --filter @marz/desktop dev      # open http://localhost:5173/?project=demo
pnpm test && pnpm typecheck
```

## Next steps (in order)

1. On Windows: spike capture first (design doc, "Technical calls" 3 to 5) before building on it.
2. Write the plan for the capture engine, then Tauri shell, recorder toolbar and export.
3. Known gaps from the final review, to schedule: see "Deferred" in `docs/LEARNINGS.md`.

## Rules

- Raw tracks (`screen.mp4`, `mic.wav`, `events.jsonl`) are never modified by the editor.
- The `project.marz` format is the contract between recorder and editor. Don't change it without
  updating the design doc and telling Mauricio.
- The editor must keep running in a plain browser against the sample project, so cloud (Linux)
  sessions can build and test it. Windows-only code stays in `crates/capture` and the Tauri shell.
- Don't claim capture/Tauri code works unless it was run on Windows.
- Stay inside M1 scope. Park other ideas instead of building them.
- Mauricio is short on time: answers straight to the point.
