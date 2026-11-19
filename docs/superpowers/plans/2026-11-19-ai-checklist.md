# AI checklist: plan

Design: `docs/superpowers/specs/2026-11-19-ai-checklist-design.md`. Test-first for every pure piece; the Tauri and capture parts are checked in the app on Windows.

1. Design system: "Recorder: checklist" (setup panel, overlay panel, hotkey), inspector Checklist tab, `list` icon. `pnpm design:check`.
2. Format (`packages/format`): `checklist` event lines (`list`, `tick`) in `events.ts`; `edits.checklist` reader `checklistItems` in `checklist.ts`. Tests first.
3. Matcher (`packages/autoedit/src/checklist.ts`): normalize, keywords, word match, `matchChecklist`, AI prompt, schema and answer check, `shouldAskAi`. Tests first.
4. Timeline (`packages/timeline/src/checklist.ts`): `importLiveChecklist`, `coverChecklist`, `clearChecklist`, `coverFromTranscript`. Tests first.
5. Capture (`crates/capture`): `checklist` event writer lines, `Session::checklist_list`, `checklist_tick`, `mic_first_rec_us`; hotkey Ctrl+Shift+K (`Hotkey::Check`, id 19). Tests first for the lines.
6. Live transcription (`crates/transcribe/src/live.rs`): WAV data offset, read new PCM from a growing file, downsample, peak gate, chunk planner. Tests first, including a file that grows while read.
7. Shell (`src-tauri`): `checklist.rs` (live thread, `checklist_tick`, `checklist_ai`), `RecordOptionsDto.checklist`, `RecState.checklist` and `checklistNote`, hotkey handling, words event to the overlay.
8. Recorder pages: setup Checklist panel (store field, saved), overlay panel, live controller (match words, ask Claude rate-limited, tick). Fake mode states for design checks.
9. Editor: import on load, Checklist tab (K), opens after Stop when topics are open, Mark here / Clear, transcript match in the AI pass.
10. Checks: `pnpm test`, `pnpm typecheck`, `pnpm design:check`, `cargo test --workspace`, screenshots at 1440 x 900, then a real recording in the Tauri app fed by `MARZ_CHECKLIST_FEED`, frame counts for 60 fps.
11. M1 design doc format contract, CLAUDE.md status line, LEARNINGS, commit on the branch.
