# Marz Recorder

Windows-first screen recorder + non-destructive editor (Tauri 2, Rust, React/TS). Owner: Mauricio.

## Read first

1. `docs/product-spec.md` — the full product vision.
2. `docs/superpowers/specs/2026-11-15-milestone-1-design.md` — what is being built now (Milestone 1)
   and the `project.marz` format contract.
3. `docs/design/avant-garde/DESIGN-SYSTEM.md` — the approved visual design (Editorial Brutalism). Binding. Also `tokens.css`, `icons.md`, `README.md` (screen list), and the `.dc.html` mockups (reference only). Editor, Home and Recorder screens are all M1 (Home and Recorder approved into M1 on 2026-11-17).

## Current status

- The Milestone 1 design is **approved** (2026-11-15). Work happens locally on Windows
  (`C:\Users\conta\source\repos\MarzVideo`); Node, pnpm, FFmpeg, VS C++ tools and Rust are installed.
- **Done:** M1 build order steps 1 to 3 (plan: `docs/superpowers/plans/2026-11-15-m1-format-and-editor.md`).
  `packages/format`, `packages/timeline`, `packages/compositor`, `tools/make-sample`, and the browser
  editor in `apps/desktop` (synced playback, timeline, zoom and cut blocks, auto zoom, undo/redo, autosave).
  Checked in a browser (Edge via Playwright) against the sample project.
- **Done:** editor restyled to the Editorial Brutalism design (2026-11-16). Deviations: `docs/design/avant-garde/DEVIATIONS.md`.
- **Done:** capture spike (2026-11-16): findings and numbers in `docs/spikes/2026-11-16-capture-spike.md`.
  The capture approach holds on Windows; the spike code grew into the capture engine in `crates/capture`.
- **Done:** M1 build order steps 4 to 6 (plan: `docs/superpowers/plans/2026-11-17-m1-capture-shell-export.md`).
  Capture engine (`crates/capture`, CLI `marz-capture record|recover`), Tauri shell with Home, recorder
  bars, global hotkeys, live zooms and crash recovery, and MP4 export (`crates/export`, `apps/desktop/src/export`).
- **Export:** the webview encodes (WebCodecs, hardware first), FFmpeg only muxes audio and writes the MP4.
  Presets: YouTube 1920 x 1080 at source fps (60 max), vertical 1080 x 1920 at 30 fps letterboxed. The preset
  is an export choice, `project.output` is unchanged. Measured: about 15 MB/min YouTube, 5 MB/min vertical,
  about 3x faster than real time. Minimum FFmpeg 5.1 (`-fps_mode`).
- **Capture facts:** no B-frames (first frame at 0; preview and export align to the first frame time for
  older files). A capture area larger than 2560 x 1440 records at 30 fps instead of 60 (the engine lowers it, the
  setup bar says so before Record). The app opens maximized; the editor fits down to 1280 x 720.
- **Done (merged 2026-11-19):** camera track (plan `docs/superpowers/plans/2026-11-18-camera-track.md`,
  design `docs/superpowers/specs/2026-11-18-camera-track-design.md`). `camera.mp4` recorded on the shared clock
  (`crates/capture/src/win/camera.rs`), setup bar picker, toggle and live preview, crash recovery, Camera lane,
  picture-in-picture in preview and export, inspector Camera block. Owner clap check: `docs/spikes/2026-11-17-owner-checks.md` section 8.
- **Done (merged 2026-11-19):** M2 AI editing (plan `docs/superpowers/plans/2026-11-17-m2-ai-editing.md`,
  design `docs/superpowers/specs/2026-11-17-milestone-2-ai-editing-design.md`, spike `docs/spikes/2026-11-19-ai-spike.md`). After Stop the
  editor runs the AI pass: local Whisper (whisper.cpp CUDA build + VAD model) writes `transcript.json`, rules cut silences and ums,
  Claude Code (`claude -p`, his subscription) finds mistakes and picks zooms, captions in preview and export, `.srt` beside exports.
  Code: `packages/autoedit` (rules, AI prompt and validator, captions), `crates/transcribe`, `src-tauri/src/ai.rs` and `transcribe.rs`.
  Whisper is looked up in `MARZ_WHISPER`, beside the exe, the app data folder `whisper` (`%APPDATA%/com.marz.recorder/whisper`), then PATH;
  models live in the app data folder `models` (downloaded after his yes). Ran end to end on this laptop on a copy of his 19.35 take.
  Open: his three test takes and the quality check (list at the end of the spike doc).
- **Done (merged 2026-11-19, not checked by ear or by hand yet):** audio cleanup (design `docs/superpowers/specs/2026-11-19-audio-cleanup-design.md`,
  plan `docs/superpowers/plans/2026-11-19-audio-cleanup.md`). Inspector Audio block: volume, mute and fade per track (mic, computer sound),
  "Remove mic noise" (FFmpeg `highpass` + `afftdn`, cached `cache/mic.clean.wav`, played in preview, read by export; RNNoise when
  `rnnoise.rnnn` is in the app data `models` folder) and "Even loudness at export" (`ebur128` measure, `loudnorm` to -14 LUFS). Optional
  `edits.audio`. App exports of the copy "Audio test": -14.8 LUFS, true peak -1.2 dB, both presets. Not listened to yet.
- **Done (merged 2026-11-19, not checked by ear or by hand yet):** camera layouts (design
  `docs/superpowers/specs/2026-11-19-camera-layouts-design.md`, plan `docs/superpowers/plans/2026-11-19-camera-layouts.md`).
  Masks (plain, round, circle, square) and border on the corner bubble; layout scenes (corner, side column, camera
  fullscreen, screen only) on the Layout lane (L adds, drag, trim, delete, undo); 0.4 s eased switches drawn by
  `packages/compositor/src/layout.ts` in preview and export; live hotkeys Ctrl+Shift+1..4 logged as `layout` events
  and turned into Live blocks when the take first opens (`importLiveLayouts`).
- **Done (merged 2026-11-19, not checked by ear or by hand yet):** captions editor (design
  `docs/superpowers/specs/2026-11-19-captions-editor-design.md`, plan `docs/superpowers/plans/2026-11-19-captions-editor.md`).
  Inspector Edit / Transcript tabs (T), click a word to jump, fix it in place, Split here (S), Join with previous (J),
  caption style per export preset (Ink, Paper, Accent band, Plain; S/M/L; top/middle/bottom; word highlight), `.vtt`
  beside every export next to the `.srt`. Code: `apps/desktop/src/captions`, `packages/autoedit/src/captions.ts`,
  `packages/compositor/src/captions.ts`.
- **Done (merged 2026-11-19, not checked by hand yet):** smart vertical (design
  `docs/superpowers/specs/2026-11-19-smart-vertical-design.md`, plan `docs/superpowers/plans/2026-11-19-smart-vertical.md`).
  The vertical export follows the action by default (a 9:16 window aimed by cursor rests, clicks and zooms; camera in a 1080 x 608
  slot; captions in the Reels/TikTok safe area) or fits with bars. Vertical preview (V) with an Aim view, Vertical lane with Frame
  blocks (F) that win over the automatic aim, Vertical block in the Project panel, "Follow the action" row in the export panel.
  Optional `edits.vertical`. Code: `packages/timeline/src/reframe.ts`, `packages/compositor/src/vertical.ts`, `apps/desktop/src/vertical`.
  App exports on copies "Vertical test" (camera) and "Vertical test clicks" in `Videos/Marz Recorder/Exports/Vertical test`, with frame sheets.
- **Done (merged 2026-11-19):** live drawing (design `docs/superpowers/specs/2026-11-19-live-drawing-design.md`,
  plan `docs/superpowers/plans/2026-11-19-live-drawing.md`). Ctrl+Shift+D (or Draw on the recording bar) while recording: pen, highlight,
  arrow, box, oval, text, erase, clear, four token colours, on the capture-excluded overlay. Strokes go to `events.jsonl` (`draw` lines) and
  become `edits.drawings` strokes on first open; Drawing lane, select/move/resize on the preview, Drawing inspector, drawn by the compositor
  in preview and both exports. Checked: real take "Drawing test" with simulated input, `screen.mp4` frames without the drawing, both exports with it.
- **Done (merged 2026-11-19, not checked by hand yet):** cursor and clicks (design
  `docs/superpowers/specs/2026-11-19-cursor-clicks-design.md`, plan `docs/superpowers/plans/2026-11-19-cursor-clicks.md`).
  `cursorShape` lines in `events.jsonl` (Windows cursor shape and size, from the 16 ms poll), `source.cursor` "layer" or "baked",
  the compositor draws the recorded shape at the recorded size (x 1, 1.5, 2), Cursor lane blocks (H) hide the cursor or switch
  click effects per section, click effects Ripple, Pulse, Ring with token colour and size, in preview and export.
  Code: `packages/format/src/cursor.ts`, `packages/timeline/src/cursor.ts`, `packages/compositor/src/cursor.ts` and `cursorShapes.ts`,
  `crates/capture/src/win/cursor.rs`, `apps/desktop/src/components/CursorPanel.tsx`.
- **Done (merged 2026-11-19, not checked by hand yet):** background and frame (design
  `docs/superpowers/specs/2026-11-19-background-frame-design.md`, plan `docs/superpowers/plans/2026-11-19-background-frame.md`).
  Optional `edits.background` (style off, ink, paper, glow, grid; margin S/M/L; corners; shadow). Off by default. The screen is
  framed inside the layout's screen box; zooms happen inside the frame; vertical Follow frames the aimed window, Fit keeps ink bars.
  Background block in the Project panel. Code: `packages/format/src/background.ts`, `packages/timeline/src/background.ts`,
  `packages/compositor/src/background.ts` (used by `frameAt` and `drawFrame`), `apps/desktop/src/components/BackgroundBlock.tsx`.
- **Done (merged 2026-11-19, not checked by hand yet):** archive and proxies (design
  `docs/superpowers/specs/2026-11-19-archive-proxies-design.md`, plan `docs/superpowers/plans/2026-11-19-archive-proxies.md`).
  Home row Storage bar: archive copies the whole `.marz` folder to a remembered folder (Google Drive for desktop suggested),
  checked by size and SHA-256 per file; "Remove raw files" makes 720p proxies in `proxies/`, re-checks the archive and moves
  `screen.mp4` and `camera.mp4` to the Recycle Bin (audio stays); "Restore from archive" copies them back, checked. State in the
  optional `archive.json` (written only by the app). Editor plays and exports from proxies (`withMedia`; `drawFrame` scales the crop to the media size);
  export asks first ("Restore from archive", "Export anyway"). Code: `src-tauri/src/archive.rs`, `packages/format/src/archive.ts`,
  `apps/desktop/src/home/storageBar.ts`. Checked in the app on copies "Archive test" (camera) and "Archive test 1080" with a scratch
  archive folder: copies hash-identical, raw files in the Recycle Bin, proxy edit and both exports, restore hash-identical. Not checked: a real Google Drive folder.
- **Done (merged 2026-11-19, not checked by hand yet):** AI checklist (design
  `docs/superpowers/specs/2026-11-19-ai-checklist-design.md`, plan `docs/superpowers/plans/2026-11-19-ai-checklist.md`).
  Topics typed on the setup bar (Checklist panel), a capture-excluded overlay panel ticks them while he talks: the growing
  `mic.wav` is read in 6 s chunks (1 s overlap, silence skipped) and run through the same whisper.cpp at below-normal priority,
  the overlay page matches the words locally (keywords, stems, typos) and asks Claude Code (haiku, text only, at most once a
  minute) about topics still open. Ctrl+Shift+K ticks the next topic by hand. `checklist` lines in `events.jsonl`,
  `edits.checklist` in `project.json`, inspector Checklist tab (K) that opens after Stop when a topic is open, Mark here / Clear,
  the AI pass re-checks open topics against the full transcript. `MARZ_CHECKLIST_FEED=<wav>` replaces the mic for tests.
  Code: `packages/autoedit/src/checklist.ts`, `packages/format/src/checklist.ts`, `packages/timeline/src/checklist.ts`,
  `crates/transcribe/src/live.rs`, `src-tauri/src/checklist.rs`, `apps/desktop/src/checklist`.
  Checked: a real take in the app fed with synthetic speech ("Checklist test.marz": 3 topics ticked locally, 1 by Claude, 1 left
  open and flagged), encoder holds 60 fps with Whisper running beside it (`pipe-bench`). Not checked: his real mic with real
  talking, typing topics by hand, Ctrl+Shift+K pressed for real.
- **Done (merged 2026-11-19, not checked by hand yet):** light theme (design `docs/superpowers/specs/2026-11-19-light-theme-design.md`,
  plan `docs/superpowers/plans/2026-11-19-light-theme.md`, DESIGN-SYSTEM.md section 3 "Light theme"). Dark (default), Light or Windows,
  stored in `localStorage` `marz.theme`, applied in every window by `src/theme.ts`; Home strip button cycles it. Light swaps ground and
  panels through tokens only (`:root[data-theme="light"]` in `tokens.css`); bare accent uses `--accent-on-ink` (accent-deep `#4A5C00` in light).
  Video output reads the fixed `--brand-*` tokens and never changes. `pnpm design:check` guards both. Checked: 1440 x 900 screenshots of Home,
  Editor (inspector, transcript, export panel, timeline) and the recorder fake pages in both themes. Not checked: the Tauri app, Windows follow mode live.
- **Done (merged 2026-11-19, not checked by hand yet):** export extras (design
  `docs/superpowers/specs/2026-11-19-export-extras-design.md`, plan `docs/superpowers/plans/2026-11-19-export-extras.md`).
  Export panel rows per preset: Codec (H.264, HEVC), Size (YouTube: 720p, 1080p, 1440p; vertical stays 1080 x 1920), Frame rate
  (24, 30, 60, capped at the recording), remembered per preset in local storage (not in `project.json`). Landscape is composited
  straight at the picked size. "Also copy to" (app only, remembered in `export-settings.json`): after a good export the MP4, `.srt`,
  `.vtt` and a `.json` sidecar (title, length, preset, codec, size, fps, caption file names) go to that folder for MarzOS, sidecar last.
  HEVC needs Chromium's `PlatformHEVCEncoderSupport`, switched on for every window at start (`src-tauri/src/webview.rs`). On this laptop
  HEVC works up to 1080p (or 1080 x 1920) at 30 fps only; above that the panel says so and the export uses H.264.
  Measured, app exports of a copy of the 19.35 take (5:43 after cuts, debug build, other sessions busy so times vary):
  H.264 1080p60 546 MB (95 MB/min), 175 to 287 s; H.264 1080p30 368 MB (64 MB/min), 92 s; HEVC 1080p30 210 MB (37 MB/min, 43% smaller), 165 s
  (slower than H.264); H.264 1440p60 1050 MB (184 MB/min), 236 s; 720p30 234 MB (41 MB/min), 66 s; 1080p24 369 MB, 78 s; vertical HEVC 30 fps
  159 MB (28 MB/min), 83 s. Every file checked with ffprobe (codec, size, fps, length, `hvc1` tag). Not checked: playback in Windows
  Media Player (HEVC there needs the HEVC Video Extensions), a real MarzOS reading the drop folder.
- **Done (merged 2026-11-19, not checked by hand yet):** camera extras (design
  `docs/superpowers/specs/2026-11-19-camera-extras-design.md`, plan `docs/superpowers/plans/2026-11-19-camera-extras.md`).
  Star and imported-SVG masks (one closed path, stored as points in `edits.camera.customMask`), Float layout (9:16 panel over the
  screen, Ctrl+Shift+5), switch presets per layout pair in `edits.camera.transitions` (length, easing, morph along or at end, a bent
  path dragged on the preview, used by live switches too). Code: `packages/compositor/src/masks.ts`, `layout.ts`,
  `packages/timeline/src/cameraExtras.ts`, `apps/desktop/src/camera`. Side column with the screen reflowed already existed.
- **Done (merged 2026-11-19, not checked by hand yet):** canvas editing and the hybrid timeline
  (design `docs/superpowers/specs/2026-11-19-canvas-editing-design.md`, plan `docs/superpowers/plans/2026-11-19-canvas-editing.md`).
  Click the corner camera bubble on the paused preview: drag it anywhere, pull a corner to resize, let go near a corner to snap
  (optional `pip.x/y`). The timeline opens on one main track (Screen, Edits, Mic; every block on Edits, stacked where they
  overlap); G or "Show lanes" switches to the lanes view, remembered per user. Code: `packages/compositor/src/pipPlace.ts`,
  `apps/desktop/src/components/CameraOverlay.tsx`, `mainTrack.ts`, `state/lanesView.ts`. Checked in Edge on both samples at
  1440 x 900 and 1280 x 720. Not checked: the Tauri app.
- **Done (merged 2026-11-19, not checked by hand yet):** onboarding and settings (design
  `docs/superpowers/specs/2026-11-19-onboarding-settings-design.md`, plan `docs/superpowers/plans/2026-11-19-onboarding-settings.md`).
  Home Settings button opens Settings: projects, exports and archive folders, default mic (with meter), camera and computer sound,
  rebindable recorder hotkeys with a clash check (`crates/capture/src/hotkeys.rs`, mirrored in `apps/desktop/src/settings/hotkeyMap.ts`),
  Whisper, models (download button) and Claude Code status, AI model, burn captions per preset, default export preset.
  Four-screen intro on first start (skippable, "Show the intro again" in Settings). File settings in `settings.json` in the app
  config folder via `src-tauri/src/settings.rs` (archive folder stays in `archive-settings.json`); localStorage ones via
  `apps/desktop/src/settings/localSettings.ts`. Browser: `?settings=1`, `?onboarding=1`.
- **Built (not merged), branch `claude/live-hide-cursor-199c34`:** live hide cursor (design
  `docs/superpowers/specs/2026-11-19-live-hide-cursor-design.md`, plan `docs/superpowers/plans/2026-11-19-live-hide-cursor.md`).
  Ctrl+Shift+H (rebindable, `hideCursor`) or "Hide cursor" on the recording bar hides the cursor in the video from then on; the
  real cursor and the capture never change. `cursorHidden` lines in `events.jsonl`, turned into Cursor lane blocks on first open
  (`importLiveCursor`, `edits.cursor.liveImported`); the live state starts at the setup bar's Hide cursor toggle. When the bar
  is wider than the monitor, Draw and Hide cursor show icons only. Checked: a real CLI take on Windows with the hotkey sent by
  simulated input (one block 2.6 s to 6.5 s on first open), fake bar and editor in Edge at 1440 x 900 and 1280 x 720.
  Not checked: the button and hotkey in the Tauri app, an export of a take with a live block.
- **Built (not merged, branch `claude/bg-image-blur-9ff3af`):** background image, blur and gradient (design
  `docs/superpowers/specs/2026-11-19-background-image-blur-design.md`, plan `docs/superpowers/plans/2026-11-19-background-image-blur.md`).
  Background styles Gradient (two brand tokens), Image (JPG/PNG copied to `assets/background-<hash>.<ext>` by the Rust command
  `pick_background_image` in `src-tauri/src/background.rs`; the dev server accepts the same PUT for the sample) and Blur (the screen frame
  blurred on a canvas 1/12 the size). Optional `edits.background.gradient` and `.image`. Checked: Edge at 1440 x 900 and 1280 x 720, browser
  exports of both presets per style (ffprobe and frame grabs). Not checked: the Tauri app (Pick image dialog, app export).
- **Built (not merged, branch `claude/scene-presets-02a719`):** scene presets ("looks") (design
  `docs/superpowers/specs/2026-11-19-scene-presets-design.md`, plan `docs/superpowers/plans/2026-11-19-scene-presets.md`).
  Project panel Look block (first): Save look stores the camera (mirror, shape incl. custom mask, size, corner or free
  position, border, switch presets), the whole `edits.background` and both caption styles under a name; Apply writes them as
  one undo step (scenes and Show camera stay); Delete. Settings, Devices, "Look": the default look, given to a take recorded
  after it was picked when it first opens and nobody styled it yet. No format change: looks live in `looks.json` in the app
  config folder (`src-tauri/src/looks.rs`), localStorage `marz.looks` in the browser. Code: `packages/timeline/src/looks.ts`,
  `apps/desktop/src/looks`. Checked in Edge at 1440 x 900 and 1280 x 720 on the samples: save, apply, undo, default on a new
  take, older take untouched. Not checked: the Tauri app (`looks.json` on disk).
- **Not checked by hand yet:** the owner checks in `docs/spikes/2026-11-17-owner-checks.md` (clean 3-minute run,
  flash and beep sync, clicks, static screen, mic unplug, 60 Hz, real hotkeys), plus: open New recording once and
  look at the overlay, play an export in Windows Media Player, upload one export of each preset privately and
  check text sharpness.

## Design rules (binding, read DESIGN-SYSTEM.md before touching any UI)

Claude drifts from the design. These rules stop that.

- Look: ink `#0B0B0A` and paper `#ECEAE4`, ONE accent `#D4FF3A`, recording red `#E0352B` only for recording and cuts. All values live in `apps/desktop/src/styles/tokens.css` (copy of `docs/design/avant-garde/tokens.css`). Never write a hex colour elsewhere.
- Fonts: Familjen Grotesk (display) and Martian Mono (labels, 11px, uppercase). No Inter, system-ui, Roboto, Arial.
- No border radius, no shadows, no blur, no gradients (except grid lines and the red hatching on cuts and the recover banner), no transitions. Tailwind's default theme is deleted in tokens.css; do not re-enable it.
- Layout: 12-column visible grid, ruled lines, giant timecode, vertical tool ledger with hotkeys, paper-colored inspector, always-visible timeline lanes. Never cards, pills or centered layouts.
- Every tool has an icon, a label and its hotkey. Copy: sentence case source, verbs first, no "successfully", "please", emoji.
- Do not invent styles or sizes. If something is missing, add it to DESIGN-SYSTEM.md in the same style first.
- Before every commit: `pnpm design:check` passes, and a 1440 x 900 screenshot (Edge via Playwright) of each changed state matches its mockup. Write any deviation in `docs/design/avant-garde/DEVIATIONS.md`.
- Stay inside the current milestone. Restyling must not change behavior or the `project.marz` format.

## Run it

```
pnpm install
pnpm sample                          # writes samples/demo.marz (gitignored)
pnpm --filter @marz/desktop dev      # plain browser: open http://localhost:5173/?project=demo
pnpm --filter @marz/desktop app:dev  # Tauri app (Windows; port 5173 must be free, strictPort)
pnpm test && pnpm typecheck
cargo test --workspace
pnpm design:check
pnpm sync-check <folder.marz|file.mp4>
# AI pass in the browser with the fixture provider: http://localhost:5173/?project=demo&ai=1 (Shift+E reruns)
cargo test -p marz-transcribe -- --ignored   # real whisper run (needs the spike files in %LOCALAPPDATA%/MarzSpike)
target/release/marz-capture record|recover   # CLI recorder (cargo build --release -p marz-capture)
```

Package tests: `pnpm --filter <pkg> exec vitest run` (packages have no test script).

## Next steps (in order)

1. Mauricio runs the owner checks (list above).
2. Fix what the final review finds.
3. Merge the branch.
4. Remaining gaps to schedule: see "Deferred" in `docs/LEARNINGS.md`.

## Rules

- Raw tracks (`screen.mp4`, `mic.wav`, `events.jsonl`) are never modified by the editor.
- The `project.marz` format is the contract between recorder and editor. Don't change it without
  updating the design doc and telling Mauricio.
- The editor must keep running in a plain browser against the sample project, so cloud (Linux)
  sessions can build and test it: no Tauri call on the browser path (gate it with `isTauri()`; a static
  `@tauri-apps/api` import is inert there). Windows-only code stays in `crates/capture/src/win` and the Tauri shell.
- Don't claim capture/Tauri code works unless it was run on Windows.
- Stay inside M1 scope. Park other ideas instead of building them.
- Mauricio is short on time: answers straight to the point.
