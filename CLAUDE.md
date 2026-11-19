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
- **Done (branch, not merged yet):** camera track (plan `docs/superpowers/plans/2026-11-18-camera-track.md`,
  design `docs/superpowers/specs/2026-11-18-camera-track-design.md`). `camera.mp4` recorded on the shared clock
  (`crates/capture/src/win/camera.rs`), setup bar picker, toggle and live preview, crash recovery, Camera lane,
  picture-in-picture in preview and export, inspector Camera block. Owner clap check: `docs/spikes/2026-11-17-owner-checks.md` section 8.
- **Done (branch `claude/ai-editing-ca47b2`, not merged yet):** M2 AI editing (plan `docs/superpowers/plans/2026-11-17-m2-ai-editing.md`,
  design `docs/superpowers/specs/2026-11-17-milestone-2-ai-editing-design.md`, spike `docs/spikes/2026-11-19-ai-spike.md`). After Stop the
  editor runs the AI pass: local Whisper (whisper.cpp CUDA build + VAD model) writes `transcript.json`, rules cut silences and ums,
  Claude Code (`claude -p`, his subscription) finds mistakes and picks zooms, captions in preview and export, `.srt` beside exports.
  Code: `packages/autoedit` (rules, AI prompt and validator, captions), `crates/transcribe`, `src-tauri/src/ai.rs` and `transcribe.rs`.
  Whisper is looked up in `MARZ_WHISPER`, beside the exe, the app data folder `whisper` (`%APPDATA%/com.marz.recorder/whisper`), then PATH;
  models live in the app data folder `models` (downloaded after his yes). Ran end to end on this laptop on a copy of his 19.35 take.
  Open: his three test takes and the quality check (list at the end of the spike doc).
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
