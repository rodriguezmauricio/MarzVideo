# Plan: onboarding and settings

Design: `docs/superpowers/specs/2026-11-19-onboarding-settings-design.md`. UI: DESIGN-SYSTEM.md "Settings" and "Onboarding".
Test first for every pure function; UI checked in the browser (`?settings=1`, `?onboarding=1`) and in the Tauri app with its own identifier.

1. `crates/capture/src/hotkeys.rs`: action ids, default combos, `parse`, `label`, bindings in force (`set_bindings`, `combo_for`), `check_bindings` (Ctrl or Alt, no duplicates, no editor or Windows keys). Tests. `win/input.rs` `Hotkey::label/keys` read it; `Hotkey::action()`.
2. `src-tauri/src/settings.rs`: `settings.json` read and write (pure functions on a path, tested with a temp folder), folders with defaults, hotkeys loaded at start and on save, onboarding flag, `ai_status`, device list, settings mic meter. `projects::default_dir` and the export start folder read it.
3. TS `src/settings/`: `hotkeyMap.ts` (combo from a key event, clash reasons, labels; tests), `localSettings.ts` (device defaults applied to every saved setup, burn, preset, AI model; tests), `settingsApi.ts` (Tauri or fake), `hotkeyStore.ts` (labels for every window).
4. Labels: Home, setup bar, recording bar, overlay, checklist overlay read the store; page Ctrl+Shift+R listeners match the bound combo.
5. Settings page (`Settings.tsx`, `settings.css`), Home button opens it, appStore screen "settings".
6. Onboarding (`Onboarding.tsx`), shown when the flag is false; "Show the intro again" in Settings.
7. Checks: `pnpm typecheck`, `pnpm test`, `pnpm design:check`, `cargo test --workspace`; browser screenshots at 1440 x 900; Tauri app with `com.marz.recorder.settingstest`: rebind Record to another combo, open the recorder, press it, see it start.
