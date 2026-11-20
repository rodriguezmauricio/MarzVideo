# Keypress log and on-video keys: plan

Design: `docs/superpowers/specs/2026-11-19-keypress-overlay-design.md`. Branch `claude/keypress-overlay-d8623b`.

1. Capture: `EventLog::key` (line format, tests). `win/keys.rs`: pure filter `should_log(mods, key)` and key names
   (unit tested), keyboard hook on the input thread when `log_keys`, password check (ES_PASSWORD, UI Automation
   `CurrentIsPassword`) after the hook returns, recorder hotkeys skipped. `RecordOptions.log_keys`, CLI `--log-keys`,
   Tauri `RecordOptionsDto.log_keys` (default off).
2. Format (TDD): `key` event; `edits.keys` helpers `keysEdits`, `keyItems`, `rawKeyItems`; format doc.
3. Timeline (TDD): `importLiveKeys`, `updateKeyItem`, `removeKeyItem`, `setKeys`.
4. Compositor (TDD): `keys.ts` (`keysLayout` pure, `drawKeys`), called by Preview, `drawVertical` and the export.
5. Editor: store loads with `importLiveKeys`, selection kind `key`, Keys lane and main track blocks, `KeysInspector`
   and Project panel `KeysPanel`, Delete. Setup bar and Settings "Log shortcuts" (device defaults `logKeys`).
6. Sample: `make-sample` writes a few `key` lines.
7. Docs: DESIGN-SYSTEM.md sections first, DEVIATIONS.md if any, LEARNINGS.md, CLAUDE.md status line.
8. Checks: pnpm test, typecheck, design:check, cargo test; browser 1440 x 900 and 1280 x 720; Tauri app (own id),
   real take with simulated combos, exports of both presets, frames checked.
