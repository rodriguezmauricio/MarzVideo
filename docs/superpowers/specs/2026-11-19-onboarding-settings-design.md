# Onboarding and settings (product spec build step 8)

Status: approved to build straight through (owner, 2026-11-19, round 4). Branch `claude/onboarding-settings-c8c378`.

## Goal

One Settings page, opened from the Home Settings button, that gathers every setting the app already
has. A first-run onboarding of four short screens, shown once, skippable, reopenable from Settings.
No new recording or editing behaviour; no `project.marz` format change.

## Where each setting lives (unchanged unless noted)

| Setting | Where it lives | Read and written by |
|---|---|---|
| Projects folder | `settings.json` in the app config folder, key `projectsDir` (new; missing = `Videos\Marz Recorder`) | `src-tauri/src/settings.rs` |
| Exports folder | `settings.json`, key `exportsDir` (new; missing = `<projects folder>\Exports`) | `settings.rs` |
| Archive folder | `archive-settings.json` (as today, key `dest`) | `settings.rs` calls `archive.rs` |
| Global hotkeys | `settings.json`, key `hotkeys` (new; only rebound keys are stored) | `settings.rs`, applied in `marz_capture::hotkeys` |
| Onboarding seen | `settings.json`, key `onboardingDone` (new) | `settings.rs` |
| Default mic, camera, computer sound | localStorage (as today, per monitor `marz.recorder.setup.*`) plus `marz.recorder.defaults` (new) for monitors with no saved setup | `src/settings/localSettings.ts` |
| Burn captions per preset | localStorage `marz.burnCaptions.<preset>` (as today) | `localSettings.ts` via `exportUi.ts` |
| Default export preset | localStorage `marz.export.preset` (as today: the row the export panel opens on) | `localSettings.ts` via `exportUi.ts` |
| AI model | localStorage `marz.ai.model` (as today, no UI until now) | `localSettings.ts` |
| Whisper, models, Claude Code | found on disk (as today) | `settings.rs` `ai_status`, `download_model` (as today) |

The app config folder is the one `archive-settings.json` already uses (`%APPDATA%\com.marz.recorder`).
Nothing moves, so nothing needs migrating. Values that live in the webview's localStorage stay there:
the recorder windows read them directly and moving them to Rust would mean a migration for no gain.
`settings.rs` is the one Rust module for every setting stored in files; `localSettings.ts` is the one
TS module for the localStorage ones.

Changing the projects folder does not move recordings. Home lists the new folder; Settings says
"Recordings already in <old> stay there. Open them with Open a project." Changing the exports folder
only changes where the save dialog starts.

Default mic, camera and computer sound: setting them in Settings or onboarding writes them into
every saved per-monitor setup and into `marz.recorder.defaults`, which `defaultSetup` uses for a
monitor that has none. The setup bar keeps changing them per recording as today.

## Hotkeys

The 19 global recorder hotkeys (Record/stop, Pause, Mute, Draw, Tick checklist, Zoom presets 1 to 9,
Zoom out, Layouts 1 to 4) each get an action id (`recordStop`, `pause`, `mute`, `preset1`..`preset9`,
`zoomOut`, `layout1`..`layout4`, `draw`, `check`). `crates/capture/src/hotkeys.rs` (portable, no
Windows calls) holds the default combos, parses "Ctrl+Shift+R", and keeps the bindings in force.
`Hotkey::keys()` and `Hotkey::label()` read it, so `RegisterHotKey` uses the rebound combo the next
time the recorder opens (setup keys) or a recording starts. The Tauri app loads `settings.json` at
start and after every save.

Rules for a combo (checked in TS for instant feedback and again in Rust on save):
- Ctrl or Alt (Shift alone is not enough), plus one key A to Z, 0 to 9 or F1 to F12.
- Not the same as another global hotkey.
- Not an editor key: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+E (bare editor keys cannot clash: globals need Ctrl or Alt).
- Not a Windows or text key: Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, Alt+F4, Alt+Tab.

Labels shown in the app (Home, setup bar, recording bar, checklist overlay) come from a small store
loaded from Rust, so a rebound key shows its new name everywhere. Page-level Ctrl+Shift+R listeners
(Home, setup bar, overlay) match the bound combo.

## AI block

Status lines: Whisper found or not (path), models downloaded or not (name and size), Claude Code found
or not. "Download models (<size>)" uses the existing `download_model`; the click is his yes. A model
picker for the AI pass (Sonnet, Opus) writes `marz.ai.model`.

## Onboarding

Shown on the app's first start (`onboardingDone` false) before Home; Skip or Done set it true.
Settings has "Show the intro again". Screens:
1. What Marz records: the separate tracks (screen, mic, computer sound, camera, cursor and clicks).
2. Pick mic and camera, with the live level meter (a meter run owned by `settings.rs`, emitting to the main window).
3. Hotkeys at a glance (the main ones, with their current combos).
4. Optional AI setup: status and the download button. Nothing downloads without the click.

In a plain browser: `?settings=1` opens Settings and `?onboarding=1` the onboarding, with fake data,
for the design check.

## Not in scope

Moving existing recordings, a default caption style for new recordings, rebinding editor keys,
registering hotkeys while the recorder is closed.
