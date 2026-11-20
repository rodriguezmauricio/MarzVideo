# Live hide cursor: plan

Design: `docs/superpowers/specs/2026-11-19-live-hide-cursor-design.md`.

1. Capture: `hotkeys.rs` ACTIONS gets `hideCursor` Ctrl+Shift+H (count 21, test); `win/input.rs` `Hotkey::HideCursor`
   (id 21, action "hideCursor"); `events.rs` `cursor_hidden(rec_us, hidden)` line + test; `win/session.rs`
   `cursor_hidden(hidden)` at `rec_us_any`; CLI `marz-capture` toggles it on the hotkey.
2. Tauri shell: `Live.cursor_hidden` (starts at the setup toggle), `RecState.cursorHidden` and `cursorBaked`,
   `imp::hide_cursor(app, to)` (logs only a change; nothing when baked), hotkey dispatch, `toggle_cursor` command.
3. Format: `cursorHidden` event schema and type in `events.ts`; `cursorLiveImported(p)` in `cursor.ts`; tests.
4. Timeline: `importLiveCursor(events)` in `cursor.ts`; tests; editor store chains it after `importLiveLayouts`.
5. Recorder: `hotkeyMap.ts` action (count test), `recorderApi` `toggleCursor` (Tauri and fake `&hidden`, `&baked`),
   RecordingBar button. DESIGN-SYSTEM.md bar section and Settings hotkey list text.
6. Checks: `pnpm typecheck`, `pnpm test`, `pnpm design:check`, `cargo test --workspace`; fake bar and editor at
   1440 x 900 and 1280 x 720; a real take on Windows with the hotkey pressed by simulated input.
7. CLAUDE.md status "Built (not merged)", commit on the branch.
