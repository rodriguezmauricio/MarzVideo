# M1 Capture Engine, Tauri Shell, Recorder and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the capture spike into the real `crates/capture` engine, wrap the editor in a Tauri 2 desktop app with Home and the recorder bars, and export the edited project to an MP4 that looks exactly like the preview.

**Architecture:** `crates/capture` becomes a library. Its timing logic (clock with pause, frame slotting, mic gap padding, event lines, `project.json` writing, live zoom pairing, recovery) lives in plain Rust modules with no Windows imports, so `cargo test` runs them anywhere. The Windows parts (WGC screen, WASAPI mic, input hook, hotkeys, capture exclusion) sit under `src/win/` and are driven by one `Session` type. The Tauri app (`apps/desktop/src-tauri`) calls `Session` through commands and hosts three webview windows: main (Home + editor), recorder overlay, recorder bar. Export reuses the editor's compositor: the webview decodes `screen.mp4` with WebCodecs, draws each output frame with `drawFrame`, encodes H.264 with the WebCodecs `VideoEncoder`, and streams the small encoded chunks to Rust, where `crates/export` runs FFmpeg to add the cut and offset mic audio and write the MP4.

**Tech Stack:** Rust 2024, `windows-capture` 2.0.1, `wasapi` 0.27, `windows` 0.62, `serde`/`serde_json`, Tauri 2, React/TS, WebCodecs, `mp4box`, FFmpeg sidecar process, Vitest, Edge via Playwright for UI checks.

**Spec:** `docs/superpowers/specs/2026-11-15-milestone-1-design.md` (build order steps 4 to 6, "Technical calls", "Format contract"). Spike facts: `docs/spikes/2026-11-16-capture-spike.md`. Design (binding): `docs/design/avant-garde/DESIGN-SYSTEM.md`.

## Decisions (approved by Mauricio on 2026-11-17, all three, plus the export presets below)

**Export presets (his ask: best quality at a small size for YouTube and Instagram/TikTok).** Two presets, picked at export time; the preset is an export choice only, `project.output` and the format do not change.

| Preset | Size | Frame rate | Video | Audio | Layout |
|---|---|---|---|---|---|
| YouTube | 1920 x 1080 | source fps (60 max) | H.264 High, VBR 12 Mbit/s at 60 fps, 8 Mbit/s at 30, keyframe every 1 s | AAC 192 kbit/s, 48 kHz | the 16:9 frame as previewed |
| Instagram and TikTok | 1080 x 1920 | 30 fps | H.264 High, VBR 6 Mbit/s, keyframe every 1 s | AAC 192 kbit/s, 48 kHz | the 16:9 frame scaled to 1080 x 608, centered at y 656 on ink (letterbox) |

Why these numbers: YouTube re-encodes every upload, so it gets the upload bitrate its help page recommends for 1080p SDR; screen content uses less of a VBR budget, so real files are usually smaller than the cap. Both platforms re-encode vertical uploads to 30 fps, so exporting 60 only wastes size. All files get `+faststart` so uploads start processing early. A real 9:16 crop that follows the zooms is the product-spec "auto-reframe" feature, out of M1 scope; letterbox ships now.

### The three decisions

1. **Export encodes video in the webview, FFmpeg only muxes.** Technical call 1 said FFmpeg encodes raw frames piped from the compositor. At 1920 x 1080 that is about 500 MB/s through the Tauri bridge, which is the risk. Plan: the WebCodecs `VideoEncoder` (Windows hardware H.264 inside WebView2) encodes; only compressed chunks (about 1 to 2 MB/s) cross to Rust; FFmpeg adds audio and writes the file. Same compositor, same pixels, so preview and export still match. Task 15 Step 1 checks the encoder exists on this machine; if it does not, the fallback is the original raw-frame pipe and the measured speed goes in the spike doc.
2. **Home and the recorder bars are built in M1.** `CLAUDE.md` and the design README call them "later milestone", but spec build step 5 needs them (you cannot record without the recorder bar or reopen a recording without Home). Task 17 corrects those two lines.
3. **New dependencies** (only `windows-capture`, `wasapi`, `windows` are approved so far):

| Dependency | Where | Why |
|---|---|---|
| `serde`, `serde_json` | Rust | Write `project.json` and event lines safely instead of hand-built strings; Tauri needs them anyway. |
| `tauri` 2, `tauri-build` 2 | Rust | The desktop shell (spec technical call 6). |
| `tauri-plugin-dialog` 2 + `@tauri-apps/plugin-dialog` | Rust + npm | Native "Open a project" folder picker and "Export MP4" save dialog. |
| `@tauri-apps/api` 2, `@tauri-apps/cli` 2 (dev) | npm | Call Rust commands from the UI; build and run the app. |
| `mp4box` | npm | Read video samples out of `screen.mp4` so WebCodecs can decode frame-exact for export. No other demuxer is in the browser. |

Not added on purpose: a global-shortcut plugin (hotkeys use `RegisterHotKey` from the approved `windows` crate, on the input thread that already runs a message loop), `uuid` (`CoCreateGuid` from `windows`), `thiserror` (hand-written error enum). FFmpeg stays an external program found on PATH (or `MARZ_FFMPEG`), not bundled in M1.

## Global Constraints

- Time: integer microseconds since recording start (`...Us`), one QPC clock. WGC `SystemRelativeTime` and WASAPI `u64QPCPosition` are both QPC in 100 ns units (`hns`).
- `durationUs` = stop time minus t0 minus total paused time. Every track is padded or cut to reach it.
- Pause removes time: no frames, samples or events are written while paused; `pause` and `resume` lines carry the same `tUs`.
- `screen.mp4`: fragmented MP4 (`frag_keyframe+empty_moov+default_base_moof`), H.264, constant frame rate, even width and height. `mic.wav`: 48 kHz mono s16 PCM.
- Event coordinates: physical pixels relative to the captured area's top-left (monitor or region). Mouse `button`: `left`, `right`, `middle` only. `startedAt`, `createdAt`: UTC, second precision.
- The `project.marz` format does not change. Recorder-only bookkeeping (the crash marker) lives in a separate file, never in `project.json`.
- Raw tracks are never modified by the editor or export.
- Our own windows are excluded from capture with `WDA_EXCLUDEFROMCAPTURE`; the cursor is never drawn into `screen.mp4`.
- WGC minimum update interval: half a frame (`500_000 / fps` us). Warm up mic and screen before t0; show "recording" only after both deliver.
- Encoder probe order: `h264_nvenc`, `h264_amf`, `h264_qsv`, `libx264`.
- The editor still runs in a plain browser against `samples/demo.marz`. Windows-only code lives in `crates/capture/src/win/` and `apps/desktop/src-tauri` only.
- UI: `DESIGN-SYSTEM.md` is binding. Before every UI commit: `pnpm design:check` passes and a 1440 x 900 Edge screenshot of each changed state matches its mockup; deviations go in `DEVIATIONS.md`. New components are written into `DESIGN-SYSTEM.md` first, in its style.
- No em-dashes, no emojis in code, docs or commits. Copy: sentence case, verbs first, no "successfully" or "please".
- Never claim capture, Tauri or export code works unless it ran on Windows. Each task says **Where:** it can be built and tested.
- Before each commit: `git pull --rebase`, stage files by name.

## Review Focus

1. **No mic, or the mic unplugged mid-take:** no mic at start records without a mic track (`tracks.mic` omitted, editor already accepts it); unplugged mid-take keeps recording, pads silence to `durationUs`, and shows a warning on the bar. Tests: Task 4 (`pads_to_duration_after_device_loss`), Task 8 Step 6.
2. **The app or PC dies mid-recording:** the folder has a crash marker and no `project.json`; Home offers Recover, which writes a valid project up to the last complete fragment. Test: Task 6 (`recovers_a_killed_recording`).
3. **Pause edge cases:** pause right after start, stop while paused, pause/resume ten times fast. Video, mic and events stay on one clock with no gap. Tests: Task 2 (`stop_while_paused`, `repeated_pause_resume`), Task 4 (`drops_samples_while_paused`).
4. **Region sizes H.264 cannot take, or regions off the screen:** odd sizes (1001 x 563) round down to even, regions are clamped to the monitor, below 64 x 64 is refused with a message. Test: Task 7 (`normalize_region`).
5. **Export that cannot finish:** everything cut away, FFmpeg missing, disk full, user cancels, target file exists. Never leave a half file under the final name; say what happened. Tests: Task 14 (`writes_to_part_then_renames`, `cancel_removes_part`), Task 15 Step 2 (all cut gives the `refuseEmpty` message).

---

## Part A: Capture engine (`crates/capture`)

### Task 1: Cargo workspace and library skeleton

**Where:** anywhere (the `win` module is `cfg(windows)`).

**Files:**
- Create: `Cargo.toml` (root workspace, members `crates/capture`, `crates/export`, `apps/desktop/src-tauri` added in Task 10), `crates/capture/src/lib.rs`, `crates/capture/src/win/mod.rs`, `crates/capture/src/bin/marz-capture.rs`
- Move: `crates/capture/src/main.rs` to `crates/capture/spike/main.rs` (kept for reference, not built; deleted in Task 8 once the CLI reproduces its numbers)
- Delete: `crates/capture/Cargo.lock` (root lock replaces it)
- Modify: `crates/capture/Cargo.toml` (add `serde` with `derive`, `serde_json`; move `windows-capture`, `wasapi`, `windows` under `[target.'cfg(windows)'.dependencies]`), `.gitignore` (`target/` at root)

**Interfaces:**
- Produces: crate `marz_capture` with modules `clock`, `slots`, `mic_timeline`, `events`, `project`, `recover`, `ffmpeg` (all cross-platform) and `win` (`#[cfg(windows)]`). Error type `pub enum CaptureError { NoFfmpeg, Device(String), Io(std::io::Error), Encoder(String), Busy }` with `Display`.

- [ ] **Step 1:** Create the workspace and empty modules. `lib.rs` declares the modules and `CaptureError`.
- [ ] **Step 2:** Run `cargo test -p marz-capture` and `cargo build -p marz-capture --bin marz-capture`. Expected: both succeed (0 tests).
- [ ] **Step 3: Commit:** `chore(capture): turn the spike into a library crate in a cargo workspace`

### Task 2: Recording clock with pause, and CFR frame slotting

**Where:** anywhere.

**Files:**
- Create: `crates/capture/src/clock.rs`, `crates/capture/src/slots.rs` (unit tests inline, `#[cfg(test)]`)

**Interfaces:**
- Produces:
  - `pub struct RecClock` with `new(t0_hns: i64)`, `pause(now_hns: i64)`, `resume(now_hns: i64)`, `is_paused(&self) -> bool`, `rec_hns(&self, qpc_hns: i64) -> Option<i64>` (None before t0 or inside a pause; otherwise QPC minus t0 minus paused time), `duration_us(&self, stop_hns: i64) -> i64` (stop while paused counts up to the pause).
  - `pub struct Slotter` with `new(fps: u32)`, `accept(&mut self, rec_hns: i64) -> Option<u64>` (slot `round((rec_hns - first) / frame_hns)`; None when the slot is not after the last accepted one, so the caller skips the GPU copy), `end_index(&self, duration_us: i64) -> u64`.
  - `pub trait FrameSink { fn write(&mut self, frame: &[u8]) -> std::io::Result<()>; }` and `pub struct CfrWriter<S: FrameSink>` with `push(&mut self, idx: u64, frame: Vec<u8>) -> io::Result<u64>` (writes the previous frame for every missed slot, then this one; returns repeats written) and `finish(&mut self, end_idx: u64) -> io::Result<u64>` (pads with the last frame to `end_idx`).

- [ ] **Step 1: Write failing tests:** `rec_time_excludes_pauses` (t0 = 0, pause at 10 s, resume at 15 s, QPC 20 s gives rec 15 s); `inside_pause_is_none`; `stop_while_paused` (duration ends at the pause time); `repeated_pause_resume` (ten 1 ms pauses: duration = wall minus 10 ms exactly); `slot_skips_second_frame_in_same_slot` (90 frames/s input at 60 fps gives strictly rising indices); `cfr_writer_repeats_missing_slots` (push idx 0 then 3: 4 frames written, 2 repeats); `finish_pads_to_end` (end_idx 10 after idx 3: 11 frames total).
- [ ] **Step 2:** `cargo test -p marz-capture clock slots`. Expected: FAIL (not implemented).
- [ ] **Step 3:** Implement. `CfrWriter` keeps the last frame buffer; `frame_hns = 10_000_000.0 / fps`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(capture): recording clock with pause and constant-frame-rate slotting`

### Task 3: Event log writer

**Where:** anywhere.

**Files:**
- Create: `crates/capture/src/events.rs`

**Interfaces:**
- Produces: `pub struct EventLog<W: Write>` with `new(out: W, header: EventsHeader, origin: (i32, i32), fps: u32) -> io::Result<Self>` (writes the header line), `cursor(&mut self, rec_us: i64, screen_x: i32, screen_y: i32)` (subtracts `origin`; at most one line per frame slot, only when the position changed since the last written line), `click(&mut self, rec_us: i64, button: Button, down: bool, screen_x: i32, screen_y: i32)`, `zoom(&mut self, rec_us: i64, preset_id: Option<&str>, action: ZoomAction)` (`ZoomAction::In` needs a preset id; `Out` writes `{"type":"zoom","action":"out"}` with no `presetId`), `pause(&mut self, rec_us: i64)`, `resume(&mut self, rec_us: i64)`, `flush(&mut self)`. `pub struct EventsHeader { width: u32, height: u32, fps: u32, started_at: String }`, `pub enum Button { Left, Right, Middle }`. Every line is one `serde_json` object followed by `\n`; the writer flushes at least once per second so a crash loses under a second.

- [ ] **Step 1: Write failing tests:** `header_matches_contract` (parses as `{"type":"header","version":1,"source":{...},"startedAt":...}`); `cursor_throttled_per_frame` (three moves within one 16.6 ms slot write one line, the first); `cursor_unchanged_not_written`; `region_origin_subtracted` (origin (100, 50), screen (110, 60) writes x 10, y 10); `click_lines` (`"button":"left","state":"down"`); `zoom_out_has_no_preset`; `pause_and_resume_same_tus`. Each test also feeds the produced text to a golden string copied from the spec's sample lines.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement with `serde_json::to_writer` on small `#[derive(Serialize)]` structs. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Cross-check against the editor parser: add `crates/capture/tests/fixtures/events-sample.jsonl` written by a test, and a Vitest case in `packages/format/src/events.test.ts` (`parses the Rust writer fixture`) that `parseEvents` accepts it. Run `pnpm --filter @marz/format test`. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(capture): event log writer matching the events.jsonl contract`

### Task 4: Mic timeline (gap padding, mute, pause)

**Where:** anywhere.

**Files:**
- Create: `crates/capture/src/mic_timeline.rs`

**Interfaces:**
- Produces: `pub struct MicTimeline` with `new(rate: u32)`, `packet(&mut self, rec_hns: Option<i64>, frames: usize) -> MicAction` and `finish(&mut self, duration_us: i64) -> u64` (silence frames to append so the file reaches `durationUs`; 0 if already there, and the caller truncates if over), `first_rec_us(&self) -> Option<i64>` (becomes `tracks.mic.offsetUs`), `padded_us(&self) -> i64`. `pub enum MicAction { Drop, Write { silence_before: u64 } }`. Rule: expected position = `(rec_us - first_rec_us) * rate / 1_000_000`; if expected exceeds written frames by more than 240 frames (5 ms), pad the difference with silence. Muting is the caller's job (it writes zeros instead of samples), so the timeline never changes.

- [ ] **Step 1: Write failing tests:** `first_packet_sets_offset`; `contiguous_packets_no_padding`; `pads_20ms_gap_from_qpc` (a packet 20 ms late with no flag gives `silence_before` 960); `ignores_small_jitter` (3 ms late: 0); `drops_samples_while_paused` (`rec_hns` None gives `Drop`, and after resume no padding is added for the paused span); `pads_to_duration_after_device_loss` (packets stop at 10 s, `finish(60 s)` returns 50 s of frames).
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit:** `feat(capture): mic timeline pads gaps from the QPC position`

### Task 5: FFmpeg sidecar for the screen track

**Where:** anywhere for the arguments; the probe runs where FFmpeg is installed.

**Files:**
- Create: `crates/capture/src/ffmpeg.rs`

**Interfaces:**
- Produces: `pub fn find_ffmpeg() -> Result<PathBuf, CaptureError>` (in order: `MARZ_FFMPEG` env var, `ffmpeg.exe` beside the running exe, PATH; `NoFfmpeg` otherwise); `pub fn probe_encoder(ffmpeg: &Path) -> String` (first of `h264_nvenc`, `h264_amf`, `h264_qsv` that encodes one 256 x 256 BGRA frame to null, else `libx264`); `pub fn screen_args(encoder: &str, w: u32, h: u32, fps: u32, out: &Path) -> Vec<String>` (raw BGRA on `pipe:0`, `-r fps`, CFR, `-movflags frag_keyframe+empty_moov+default_base_moof`; `libx264` gets `-preset veryfast -pix_fmt yuv420p`, hardware encoders take BGRA as in the spike); `pub struct ScreenEncoder` with `spawn(ffmpeg: &Path, args: &[String]) -> Result<Self, CaptureError>`, `impl FrameSink`, `finish(self) -> Result<(), CaptureError>` (closes stdin, waits, maps a non-zero exit to `Encoder` with the last 20 stderr lines).

- [ ] **Step 1: Write failing tests:** `args_contain_fragmented_flags`; `libx264_gets_yuv420p`; `missing_ffmpeg_is_no_ffmpeg` (env var set to a missing path and PATH emptied for the test process: `NoFfmpeg`); `encodes_ten_frames` (skipped with a printed note when FFmpeg is absent: spawn with 64 x 64, push 10 grey frames, `ffprobe` reports 10 frames).
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement (move the spike's `pick_encoder` and `spawn_ffmpeg` here). **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit:** `feat(capture): FFmpeg sidecar with encoder probe`

### Task 6: project.json writer, live zooms, crash recovery

**Where:** anywhere (recovery tests need FFmpeg).

**Files:**
- Create: `crates/capture/src/project.rs`, `crates/capture/src/recover.rs`
- Test fixture: `crates/capture/tests/fixtures/killed.marz/` is generated by the test, not committed.

**Interfaces:**
- Produces:
  - `pub struct ZoomPreset { id: String, name: String, rect: NormRect }`, `pub struct NormRect { x: f64, y: f64, w: f64, h: f64 }`, `pub struct LiveZoomMark { t_us: i64, preset_id: Option<String> }` (None = zoom out).
  - `pub fn live_zooms(marks: &[LiveZoomMark], presets: &[ZoomPreset], duration_us: i64) -> Vec<serde_json::Value>`: a mark with a preset starts a zoom; it ends at the next mark (out or another preset) or at `duration_us`; ids `live-1`, `live-2`, ...; `origin: "live"`, `easeInUs`/`easeOutUs` 400000, `easing: "easeInOutCubic"`, rect copied from the preset; zero-length zooms are dropped; unknown preset ids are skipped.
  - `pub struct ProjectMeta { id, name, created_at, duration_us, width, height, fps, screen_offset_us, mic: Option<MicMeta { offset_us }>, cursor_hidden: bool, presets: Vec<ZoomPreset>, zooms: Vec<Value> }` and `pub fn write_project_json(dir: &Path, meta: &ProjectMeta) -> io::Result<()>` (writes `project.json.tmp` then renames; `output` is 1920 x 1080 at the source fps; `edits.cursor.hidden` from `cursor_hidden`; `clicks.effect: "none"`).
  - `pub const CRASH_MARKER: &str = ".recording"`; the marker file holds the `ProjectMeta` JSON known at start (everything except duration, offsets and zooms).
  - `pub fn needs_recovery(dir: &Path) -> bool` (marker present, `project.json` absent) and `pub fn recover(dir: &Path, ffprobe: &Path) -> Result<RecoverReport, CaptureError>`: duration = shortest of screen (ffprobe on the fragmented file) and mic (data size); patches the WAV header sizes; replays `events.jsonl` (dropping a broken last line) for live zoom marks; writes `project.json`; removes the marker. `RecoverReport { duration_us: i64 }`.

- [ ] **Step 1: Write failing tests:** `project_json_parses_as_contract` (output matches the spec example's shape; also written to `crates/capture/tests/fixtures/project-sample.json` and checked by a new Vitest case `parses the Rust project fixture` in `packages/format/src/project.test.ts`); `no_mic_omits_track`; `live_zoom_pairs_in_and_out`; `live_zoom_preset_to_preset`; `live_zoom_open_until_stop`; `write_is_atomic` (a pre-existing `project.json.tmp` from a crash is overwritten, final file is complete); `recovers_a_killed_recording` (test makes a folder with an FFmpeg-made 3 s fragmented `screen.mp4` cut mid-fragment, a WAV with zero header sizes, events with a broken last line, and the marker; `recover` yields a `project.json` that parses, duration within 1 s of 3 s, valid WAV header, marker gone).
- [ ] **Step 2:** Run (`cargo test -p marz-capture project recover` and `pnpm --filter @marz/format test`), expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit:** `feat(capture): project.json writer, live zoom blocks, crash recovery`

### Task 7: Windows capture parts (screen, mic, input, hotkeys, exclusion)

**Where:** Windows only.

**Files:**
- Create: `crates/capture/src/win/qpc.rs`, `win/screen.rs`, `win/mic.rs`, `win/input.rs`, `win/exclude.rs`, `win/monitors.rs`
- Modify: `crates/capture/Cargo.toml` (`windows` features: add `Win32_System_Com` for `CoCreateGuid`)

**Interfaces:**
- Consumes: `RecClock`, `Slotter`, `MicTimeline`, `EventLog` (all behind `Arc<Mutex<..>>` or channels owned by `Session` in Task 8).
- Produces:
  - `qpc_hns() -> i64`, `new_guid() -> String`.
  - `pub struct MonitorInfo { index: usize, name: String, x: i32, y: i32, width: u32, height: u32, refresh_hz: u32, primary: bool }`, `list_monitors() -> Vec<MonitorInfo>`.
  - `pub struct PxRect { x: i32, y: i32, w: u32, h: u32 }` (monitor-relative) and `pub fn normalize_region(r: PxRect, monitor_w: u32, monitor_h: u32) -> Result<PxRect, String>` (clamp to the monitor, round width and height down to even, refuse below 64 x 64 with "Region is too small. Drag at least 64 x 64."). This function lives in `src/region.rs` (cross-platform) so it is tested anywhere.
  - `screen.rs`: WGC handler as in the spike (`WithoutCursor`, `WithoutBorder`, minimum interval half a frame) plus: crop to the region during the copy; reuse one scratch buffer and a pool of 6 frame buffers returned by the writer thread (no allocation per frame); sets a `screen_warm` flag on the first frame.
  - `mic.rs`: `pub struct MicDevice { id: String, name: String, default: bool }`, `list_mics() -> Vec<MicDevice>`, capture thread as in the spike, routing every packet through `MicTimeline`; writes zeros when muted; publishes a peak level (0 to 1) every 50 ms for the meter; reports device loss (`AUDCLNT_E_DEVICE_INVALIDATED`) as a warning instead of failing.
  - `input.rs`: one thread with a message loop: low-level mouse hook + 16 ms `GetCursorPos` poll (catches `SetCursorPos` moves), and `RegisterHotKey` for the recorder hotkeys (`Hotkey::{RecordStop, Pause, Mute, Preset(u8), ZoomOut}`), registered only while a session or the recorder setup is open. A hotkey another app already owns is reported as `Warning("Hotkey Ctrl+1 is taken by another app")`, not an error.
  - `exclude.rs`: `exclude_from_capture(hwnd: isize) -> Result<(), CaptureError>` (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`).

- [ ] **Step 1: Write failing tests (cross-platform, `src/region.rs`):** `normalize_region` cases: odd 1001 x 563 becomes 1000 x 562; a region hanging off the right edge is clamped; 40 x 40 is refused with the exact message; the full monitor is unchanged.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement `region.rs`, then the `win` modules (move spike code, apply the interfaces above). **Step 4:** Run, expect PASS; `cargo build -p marz-capture` on Windows is clean with no warnings.
- [ ] **Step 5: Commit:** `feat(capture): Windows screen, mic, input, hotkeys and exclusion modules`

### Task 8: Session and CLI

**Where:** Windows only.

**Files:**
- Create: `crates/capture/src/win/session.rs`
- Modify: `crates/capture/src/bin/marz-capture.rs`
- Delete: `crates/capture/spike/main.rs`

**Interfaces:**
- Consumes: everything from Tasks 2 to 7.
- Produces:
  - `pub struct RecordOptions { out_dir: PathBuf, name: String, monitor: usize, region: Option<PxRect>, fps: u32, mic_id: Option<String>, cursor_hidden: bool, presets: Vec<ZoomPreset>, encoder: Option<String> }` (`mic_id` None = record without mic).
  - `pub enum SessionEvent { Recording, MicLevel(f32), Warning(String), Hotkey(Hotkey), Failed(String) }`.
  - `pub struct Session` with `start(opts: RecordOptions, on_event: Box<dyn Fn(SessionEvent) + Send + Sync>) -> Result<Session, CaptureError>`, `pause(&self)`, `resume(&self)`, `set_mic_muted(&self, muted: bool)`, `zoom(&self, preset_id: Option<&str>)`, `stop(self) -> Result<StopReport, CaptureError>`. `pub struct StopReport { dir: PathBuf, duration_us: i64, frames_written: u64, frames_repeated: u64, mic_padded_us: i64 }`.
  - Start order (from the spike): create folder and crash marker, find FFmpeg and probe, spawn encoder, start input thread, start mic and screen, wait until both are warm (max 3 s, else `Failed("The microphone did not start. Pick another one or record without it.")`), take t0, write the events header, emit `Recording`. Stop order: take stop time, compute `end_index`, stop WGC, finish the writer, finish the mic (pad or truncate), stop input, finish FFmpeg, write `project.json` with live zooms, remove the marker.
  - CLI: `marz-capture record <out.marz> [--secs N] [--fps N] [--encoder E] [--region x,y,w,h] [--no-mic] [--report]`, printing the spike's report lines.

- [ ] **Step 1:** Implement `Session` and the CLI.
- [ ] **Step 2: Repeat the spike's 3-minute run with the CLI** on the same content (Edge redrawing, scripted mouse) and compare to the spike table. Expected: 60 fps CFR, repeats under 0.5%, mic drift under 2 ms, offsets under 20 ms, CPU within 20% of the spike. The output folder opens in the browser editor (`?project=<name>`) with screen, mic, waveform and cursor.
- [ ] **Step 3: Pause run:** 60 s recording with three pauses (one right after start, one stop while paused) via a `--pause-at 0.5,20,40 --resume-at 5,25` CLI flag. Expected: `durationUs` = wall time minus paused time within one frame; video frame count matches `durationUs`; events show `pause`/`resume` pairs with equal `tUs`.
- [ ] **Step 4: Region run:** `--region 101,101,1001,563`. Expected: `source` is 1000 x 562, a frame grab shows the right area, cursor coordinates are region-relative (move to the region's top-left, x and y near 0).
- [ ] **Step 5: Crash run:** start a 60 s recording, kill the process at 20 s (`taskkill /F`), run `recover` through a `marz-capture recover <dir>` subcommand. Expected: project opens in the editor, about 20 s long.
- [ ] **Step 6: Mic loss run:** unplug or disable the mic in Sound settings at 10 s of a 30 s recording (Mauricio does this by hand if no USB mic: disable the device in Settings). Expected: recording continues, a warning is printed, `mic.wav` is padded to `durationUs`.
- [ ] **Step 7:** Write the numbers of Steps 2 to 6 into `docs/spikes/2026-11-16-capture-spike.md` under a new "Engine run (2026-11-xx)" section.
- [ ] **Step 8: Commit:** `feat(capture): recording session with pause, mute, live zooms and recovery`

### Task 9: Audio/video sync check and the high-resolution pipe check

**Where:** analyzer anywhere; probe and runs on Windows.

**Files:**
- Create: `tools/sync-check/package.json` (`@marz/sync-check`, script `sync-check` via `tsx`), `tools/sync-check/detect.ts`, `tools/sync-check/sync-check.ts` (CLI), `tools/sync-check/detect.test.ts`
- Create: `crates/capture/src/win/sync_probe.rs` (CLI flag `--sync-probe`), `crates/capture/src/bin/pipe-bench.rs`
- Modify: `tools/make-sample/make-sample.ts` (option `syncOffsetMs`: draws a white full frame and a 1 kHz 100 ms beep every 3 s, the beep shifted by the given ms), root `package.json` (script `sync-check`)

**Interfaces:**
- Produces (TS, pure): `detectFlashes(luma: Uint8Array, fps: number): number[]` (us of each frame where mean luma jumps from below 40 to above 200), `detectOnsets(samples: Int16Array, rate: number, minGapMs = 500): number[]` (us where a 2 ms RMS window first exceeds 8x the median RMS of the preceding 200 ms), `pairNearest(a: number[], b: number[], maxGapUs: number): number[]` (deltas b minus a), `summarize(deltasUs: number[]): { count: number; meanMs: number; minMs: number; maxMs: number; spreadMs: number }`.
- CLI: `pnpm sync-check <folder.marz | file.mp4>`. For a project: luma per frame from `screen.mp4` via `ffmpeg -vf scale=1:1,format=gray -f rawvideo -`, audio from `mic.wav`, both shifted by their `offsetUs`; also pairs `click` `down` events with sound onsets. For an MP4: video and audio from the file. Prints flash-to-beep and click-to-sound summaries and PASS or FAIL.
- Probe (`--sync-probe`): a plain (not excluded) black window on the captured monitor; every 3 s it turns white for 100 ms and, at the same QPC time, plays a 1 kHz 100 ms beep through the default output with `wasapi` render. Prints the render stream latency WASAPI reports.
- `pipe-bench`: pushes synthetic BGRA frames into `ScreenEncoder` at 1920 x 1080, 2560 x 1440 and 3840 x 2160 for 20 s each at 60 fps and prints sustained fps and CPU.

- [ ] **Step 1: Write failing tests (`detect.test.ts`):** `detectFlashes` on a synthetic luma array finds frames 30 and 210 at 30 fps (1,000,000 and 7,000,000 us); `detectOnsets` finds a beep inserted at 1.000 s in noise to within 1 ms; `analyzer on a synthetic sample` (make-sample with `syncOffsetMs: 0` reports mean 0 ms within 1 frame; with `syncOffsetMs: 30` reports 30 ms within 1 frame).
- [ ] **Step 2:** Run `pnpm --filter @marz/sync-check test`, expect FAIL. **Step 3:** Implement detect and CLI. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Real sync run (Windows, speakers on, laptop mic):** `marz-capture record samples/sync.marz --secs 63 --sync-probe`, then `pnpm sync-check samples/sync.marz`. Pass: 20 pairs found, spread at most 17 ms (one frame at 60 fps), mean absolute offset at most 45 ms (the point where people start to notice), and the mean is within 10 ms of the render latency WASAPI reports. Then the click test: 10 loud mouse clicks close to the mic during a 30 s recording; click event to click sound mean at most 20 ms.
- [ ] **Step 6: Listen check (Mauricio, 1 minute):** open `samples/sync.marz` in the editor and confirm the beep and the flash land together. Not checked until he says so.
- [ ] **Step 7: Pipe check:** run `pipe-bench`. Pass: 60 fps sustained at 1440p. If 1440p or 4K fails, record the numbers in the spike doc and cap capture at 30 fps above 1440p in `RecordOptions` validation (message: "This screen records at 30 fps"). The GPU path (Media Foundation with D3D11 input) is parked, not built in M1. Also ask Mauricio to set the screen to 60 Hz once and rerun Task 8 Step 2 for 30 s (spike open point).
- [ ] **Step 8:** Write results into the spike doc ("Sync check" and "Pipe check" sections) and a line in `docs/LEARNINGS.md`.
- [ ] **Step 9: Commit:** `feat: audio/video sync check with flash, beep and click analysis`

---

## Part B: Tauri shell

### Task 10: Tauri 2 app around the editor

**Where:** Windows to run; the browser dev path keeps working anywhere.

**Files:**
- Create: `apps/desktop/src-tauri/` (`Cargo.toml` depending on `marz-capture` and `marz-export`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`, `src/lib.rs`, `icons/` generated by `tauri icon` from a plain accent square)
- Modify: `apps/desktop/package.json` (deps `@tauri-apps/api`, `@tauri-apps/plugin-dialog`; dev dep `@tauri-apps/cli`; scripts `tauri`, `app:dev` = `tauri dev`), root `Cargo.toml` (member), `apps/desktop/vite.config.ts` (multi-page inputs `index.html`, `recorder.html`, `bar.html`; `clearScreen: false`, fixed port 5173)

**Interfaces:**
- Produces: `pub fn is_tauri(): boolean` in `apps/desktop/src/platform.ts` (`"__TAURI_INTERNALS__" in window`). Main window 1440 x 900, min 1280 x 800, title "Marz Recorder", decorations on. Asset protocol enabled with scope = projects folder (Task 11) plus any folder the user opens (added at runtime with the `fs_scope` API).

- [ ] **Step 1:** Scaffold with `pnpm tauri init` settings matching the above; the main window loads the existing editor.
- [ ] **Step 2:** Run `pnpm --filter @marz/desktop app:dev`. Expected: a native window shows the editor with `samples/demo.marz` loaded through the existing dev middleware (HTTP storage still works inside Tauri dev). `pnpm --filter @marz/desktop dev` in a plain browser still works. `pnpm test && pnpm typecheck` pass.
- [ ] **Step 3: Commit:** `feat(desktop): Tauri 2 shell around the editor`

### Task 11: Tauri storage, projects folder, Home screen

**Where:** Windows for the Tauri parts; Home UI checked in the browser against fake data.

**Files:**
- Create: `apps/desktop/src-tauri/src/projects.rs`, `apps/desktop/src/storage/tauriStorage.ts`, `apps/desktop/src/storage/pickStorage.ts`, `apps/desktop/src/home/Home.tsx`, `apps/desktop/src/home/projectRows.ts`, `apps/desktop/src/home/projectRows.test.ts`, `apps/desktop/src/state/appStore.ts`
- Modify: `apps/desktop/src/App.tsx` (screen switch Home or Editor), `apps/desktop/src/state/editorStore.ts` (`load` takes a `ProjectStorage` instead of a name), top strip back link "Projects" becomes live

**Interfaces:**
- Produces (Rust commands): `projects_dir() -> String` (default `%USERPROFILE%\Videos\Marz Recorder`, created on first run), `list_projects() -> Vec<ProjectRow>` (`ProjectRow { dir, name, duration_us, zooms, cuts, edited_at, needs_recovery }`, newest first; folders ending `.marz` only), `read_text(dir, path) -> String`, `write_project_json(dir, text)` (temp file + rename: closes the "not atomic" item in LEARNINGS Deferred), `allow_dir(dir)` (adds an opened folder to the asset scope), `recover_project(dir)` (calls `marz_capture::recover`), `discard_project(dir)` (moves the folder to the Recycle Bin with `IFileOperation`, never a hard delete).
- Produces (TS): `createTauriStorage(dir: string): ProjectStorage` (`fileUrl` via `convertFileSrc`); `pickStorage(): ...` returns HTTP storage in a browser and Tauri storage in the app; `appStore` with `screen: "home" | "editor"`, `openProject(dir)`, `goHome()`; `toRows(raw: ProjectRow[], now: Date): RowView[]` formats index "01", length `mm:ss`, meta "3 zooms, 1 cut, edited 2 hours ago".
- Home per `DESIGN-SYSTEM.md` "Home" and `Home.dc.html` / `Home-Empty.dc.html`: hero "Record once.", New recording (opens the recorder, Task 12), Open a project (folder dialog, must end in `.marz` or contain `project.json`, else the warning bar "This folder is not a Marz project. Pick a folder that ends in .marz."), recover banner for each row with `needs_recovery` ("Interrupted: <name>. The video up to <mm:ss> is safe.", Recover, Discard; Discard asks "Move <name> to the Recycle Bin?" first), ruled recent rows, empty state.

- [ ] **Step 1: Write failing tests (`projectRows.test.ts`):** `formats length and meta`; `singular forms` ("1 zoom, 1 cut"); `edited just now` under a minute; `rows newest first`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement rows, storage, commands, Home. **Step 4:** Run tests, expect PASS.
- [ ] **Step 5: Check (Windows app):** Home lists the CLI recordings copied into the projects folder; Open opens one in the editor; edits autosave to disk (hash the three raw files before and after: unchanged); the killed recording from Task 8 Step 5 shows the banner and Recover opens it.
- [ ] **Step 6: Design check:** `pnpm design:check`; 1440 x 900 Edge screenshots of Home and Home empty (browser, fake rows behind `?home=fake`) next to `Home.dc.html` and `Home-Empty.dc.html`; deviations into `DEVIATIONS.md`.
- [ ] **Step 7: Commit:** `feat(desktop): Home screen, Tauri storage with atomic saves, crash recovery`

---

## Part C: Recorder

### Task 12: Recorder design additions, then the setup state

**Where:** design and UI in the browser; capture wiring on Windows.

**Files:**
- Modify first: `docs/design/avant-garde/DESIGN-SYSTEM.md` (section 6 additions below, same style), `docs/design/avant-garde/README.md` hotkey line
- Create: `apps/desktop/recorder.html`, `apps/desktop/bar.html`, `apps/desktop/src/recorder/Overlay.tsx`, `apps/desktop/src/recorder/SetupBar.tsx`, `apps/desktop/src/recorder/recorderStore.ts`, `apps/desktop/src/recorder/regionMath.ts`, `apps/desktop/src/recorder/regionMath.test.ts`, `apps/desktop/src-tauri/src/recorder.rs`

**Design additions (write into DESIGN-SYSTEM.md before any code):**
- Recorder hotkeys: Record / stop Ctrl+Shift+R, Pause / resume Ctrl+Shift+P, Mute mic Ctrl+Shift+M, zoom presets Ctrl+1 to Ctrl+9, Zoom out Ctrl+0. Registered only while the recorder is open.
- Mode picker in M1: Full screen and Region work; Exact size is Region with typed width and height (two 1px line boxes in the size chip); Window is faint with the existing dashed "Not in this version" tag.
- Starting state: after Record, the Record button reads "Starting..." (faint, disabled) until the engine reports Recording. No countdown.
- Error line on the bar: paper block, ink text, alert icon (same as the warning bar), for "No microphone found. Recording without sound.", "Region is too small. Drag at least 64 x 64.", "FFmpeg is missing. Install it or set MARZ_FFMPEG.".

**Interfaces:**
- Consumes: `lockAspect` from `@marz/timeline`; `Session`, `list_mics`, `list_monitors`, `normalize_region`, `exclude_from_capture`.
- Produces (Rust commands): `open_recorder()` (opens `overlay`: transparent, frameless, always-on-top window covering the monitor the main window is on; and `bar`: small frameless always-on-top window at bottom centre, y 704 at 1440 x 900 scaled to the monitor; both excluded from capture right after creation; the main window hides), `close_recorder()`, `list_mics() -> Vec<MicDevice>`, `start_mic_meter(mic_id)` (emits `recorder://level` every 50 ms during setup), events `recorder://state`.
- Produces (TS): `regionMath.ts`: `dragRect(start: Pt, end: Pt, bounds: Size): PxRect` (any drag direction), `resizeRect(rect, handle: Handle, to: Pt, bounds, lockAspect?: number): PxRect`, `toNorm(rect: PxRect, source: Size): NormRect`. `recorderStore`: `mode`, `region`, `presets` (max 9, names "Zoom 1".."Zoom 9" by default, editable), `micId`, `cursorHidden`; persisted to `localStorage` per monitor so the last setup comes back.

- [ ] **Step 1:** Write the design additions into `DESIGN-SYSTEM.md` and the README; commit them alone: `docs(design): recorder hotkeys, modes, starting and error states`.
- [ ] **Step 2: Write failing tests (`regionMath.test.ts`):** drag up-left gives a positive rect; resize from a corner with aspect 16/9 keeps the ratio; rect clamped to bounds; `toNorm` of a full-screen rect is `{0,0,1,1}`; presets are drawn inside the region and stored normalized to the region, not the monitor.
- [ ] **Step 3:** Run, expect FAIL. **Step 4:** Implement math, overlay (mode picker top centre y 28, region per "Recorder: capture region", presets per "Recorder: zoom presets" with aspect locked to the output 16:9 via `lockAspect`), setup bar per "Recorder: bar BEFORE recording" (mic picker, level meter 14 bars, Camera disabled with the dashed tag, Hide cursor toggle, Record button, "never captured" chip). **Step 5:** Run tests, expect PASS.
- [ ] **Step 6: Check:** browser screenshots at 1440 x 900 of the setup state (overlay and bar composed on a page `?recorder=fake`) against `Recorder-Setup.dc.html`; `pnpm design:check`. On Windows: the overlay and bar are absent from a WGC frame grab (record 5 s with them open; extract a frame with FFmpeg and look).
- [ ] **Step 7: Commit:** `feat(recorder): setup overlay with modes, region, zoom presets and mic meter`

### Task 13: Recording state, hotkeys, stop into the editor

**Where:** Windows.

**Files:**
- Create: `apps/desktop/src/recorder/RecordingBar.tsx`, `apps/desktop/src/recorder/timer.ts`, `apps/desktop/src/recorder/timer.test.ts`
- Modify: `apps/desktop/src-tauri/src/recorder.rs`, `apps/desktop/src/recorder/Overlay.tsx`

**Interfaces:**
- Consumes: `Session` (Task 8), `SessionEvent`.
- Produces (Rust commands): `start_recording(opts: RecordOptionsDto) -> ()` (folder name `<YYYY-MM-DD HH.mm> Recording.marz` in the projects folder), `pause_recording()`, `resume_recording()`, `set_mic_muted(muted)`, `trigger_zoom(preset_id: Option<String>)`, `stop_recording() -> String` (project dir; closes the recorder windows, shows the main window and opens the project in the editor). Hotkeys from the session are applied in Rust (not the webview), so they work while another app has focus.
- Produces (TS): `formatTimer(recUs: number): string` (`mm:ss`, `h:mm:ss` past an hour); the timer counts recording time from `recorder://state` ticks, frozen while paused.
- Recording bar per "Recorder: bar WHILE recording": rec square + timer, Pause (label flips to Resume), Mute mic with meter, one button per preset ("1 Zoom 1", active = accent while that preset is live), Zoom out, Stop. Overlay switches to click-through (`set_ignore_cursor_events(true)`), draws the 3px rec region border and the top-left chip. "Recording" chip and timer appear only after `SessionEvent::Recording` (warm-up rule).

- [ ] **Step 1: Write failing tests (`timer.test.ts`):** `0 -> 00:00`, `61_500_000 -> 01:01`, `3_723_000_000 -> 1:02:03`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Check (Windows, by Claude through the running app, then Mauricio once):** record 60 s of real work in Region mode with two presets: trigger Ctrl+1, Ctrl+2, Ctrl+0 while another app has focus; pause and resume once with Ctrl+Shift+P; mute for 5 s; stop with Ctrl+Shift+R. Expected: the editor opens with live zoom blocks at the trigger times with the preset rects, the muted stretch is silent, the pause left no gap, and neither bar is visible in the video.
- [ ] **Step 6: Design check:** 1440 x 900 screenshot of the recording state (`?recorder=fake&state=recording`) against `Recorder-Recording.dc.html`; `pnpm design:check`; deviations recorded.
- [ ] **Step 7: Commit:** `feat(recorder): recording bar, global hotkeys, live zooms, stop into the editor`

---

## Part D: Export

### Task 14: Export muxer crate (`crates/export`)

**Where:** anywhere (tests need FFmpeg).

**Files:**
- Create: `crates/export/Cargo.toml` (deps `serde`, `serde_json`), `crates/export/src/lib.rs`, `crates/export/src/args.rs`, `crates/export/src/process.rs`

**Interfaces:**
- Produces: `#[derive(Deserialize)] pub struct ExportJob { project_dir: PathBuf, out_path: PathBuf, width: u32, height: u32, fps: u32, segments: Vec<Segment>, mic: Option<MicJob>, output_duration_us: i64 }`, `Segment { src_start_us: i64, src_end_us: i64, out_start_us: i64 }` (same fields as `@marz/timeline` `Segment`, camelCase in JSON), `MicJob { file: String, offset_us: i64, volume: f64, muted: bool }`.
  - `pub fn audio_filter(job: &ExportJob) -> Option<String>`: None when no mic or muted (then a silent AAC track is still written with `anullsrc` so every export has audio); otherwise per segment `atrim` on the mic timeline (segment source times minus `offset_us`, clamped at 0, with `adelay` for a positive start gap), `concat`, `volume`, `apad`, and `atrim` to `output_duration_us`.
  - `pub fn ffmpeg_args(job: &ExportJob) -> Vec<String>`: video `-f h264 -r <fps> -i pipe:0` copied (`-c:v copy`), audio from `mic.wav` through the filter, AAC 192 kbit/s 48 kHz, `-movflags +faststart`, `-shortest` off, output `<out_path>.part`.
  - `pub struct ExportProcess` with `start(ffmpeg: &Path, job: ExportJob) -> io::Result<Self>`, `write_chunk(&mut self, bytes: &[u8]) -> io::Result<()>`, `finish(self) -> Result<ExportReport, String>` (waits, renames `.part` to the final name, replacing an existing file only because the save dialog already asked), `cancel(self)` (kills FFmpeg, deletes `.part`). `ExportReport { out_path, duration_us, size_bytes }`.

- [ ] **Step 1: Write failing tests:** `filter_trims_each_segment` (two segments: two `atrim` with the exact second values, one `concat=n=2:v=0:a=1`); `filter_shifts_by_mic_offset` (offset 12400 us shifts start by 0.0124 s); `muted_uses_silence`; `no_mic_uses_silence`; `writes_to_part_then_renames` (with FFmpeg: feed a tiny H.264 elementary stream made by FFmpeg in the test; final file exists, `.part` gone, ffprobe shows video and audio); `cancel_removes_part`; `ffmpeg_failure_keeps_target_untouched` (bad input: `finish` returns Err with FFmpeg's last stderr lines, an existing file at `out_path` is unchanged).
- [ ] **Step 2:** Run `cargo test -p marz-export`, expect FAIL. **Step 3:** Implement (`find_ffmpeg` is reused from `marz-capture::ffmpeg` by moving it into `marz-export` and re-exporting from capture, so there is one copy). **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit:** `feat(export): FFmpeg muxer with cut and offset mic audio`

### Task 15: Export frame pipeline in the webview

**Where:** anywhere (Edge for the browser check); Step 1 on Windows.

**Files:**
- Create: `apps/desktop/src/export/presets.ts`, `apps/desktop/src/export/outputFrames.ts`, `apps/desktop/src/export/outputFrames.test.ts`, `apps/desktop/src/export/frameSource.ts`, `apps/desktop/src/export/exportVideo.ts`, `apps/desktop/src/export/sink.ts`, `apps/desktop/src/export/memorySink.ts`
- Modify: `apps/desktop/package.json` (dep `mp4box`), `packages/compositor/src/draw.ts` (`ctx` type widened to `CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D`, no behaviour change); if `Preview.tsx` maps source time to media time inline (screen `offsetUs`), move that into `playback/clock.ts` as `mediaTimeSec(project, srcUs)` and use it in both places.

**Interfaces:**
- Consumes: `keptSegments`, `outputDurationUs`, `outputToSource` (`@marz/timeline`), `frameAt`, `drawFrame` (`@marz/compositor`).
- Produces:
  - `presets.ts`: `type ExportPresetId = "youtube" | "vertical"`; `interface ExportPreset { id; label: string; width: number; height: number; fps(sourceFps: number): number; bitrate(fps: number): number; keyframeEverySec: 1; frameRect: { x: number; y: number; w: number; h: number } }` with the values from the "Export presets" table at the top; `PRESETS: Record<ExportPresetId, ExportPreset>`.
  - `outputFrameTimes(segs: Segment[], fps: number): Iterable<number>` (source us for output frame k at `k / fps`, k from 0 while `k / fps < outputDuration`); `refuseEmpty(segs): string | null` returns "Nothing left to export. Every part is cut." when the output is empty.
  - `interface FrameSource { frameAt(mediaUs: number): Promise<VideoFrame>; close(): void }` and `createFrameSource(url: string): Promise<FrameSource>` (mp4box demux, `VideoDecoder`, decodes forward only, returns the latest frame with timestamp at or before `mediaUs`, closes older frames; a backwards request re-seeks from the previous keyframe).
  - `interface ExportSink { begin(job: ExportJobDto): Promise<void>; chunk(data: Uint8Array): Promise<void>; finish(): Promise<ExportReport>; cancel(): Promise<void> }`; `createMemorySink(): ExportSink & { bytes(): Uint8Array }` for tests.
  - `exportProject(opts: { project: Project; events: MarzEvent[]; storage: ProjectStorage; sink: ExportSink; preset: ExportPreset; outPath: string; signal: AbortSignal; onProgress(p: number): void }): Promise<ExportReport>`: `frameAt` + `drawFrame` into an OffscreenCanvas at `project.output` (the preview's 16:9 frame), then that canvas is drawn into an encode canvas of `preset.width x preset.height` at `preset.frameRect` on ink (for YouTube the rect is the whole canvas). `VideoEncoder` (`avc1.640028`, `avc: { format: "annexb" }`, `hardwareAcceleration: "prefer-hardware"`, `bitrateMode: "variable"`, bitrate and keyframes from the preset), keeps at most 8 frames in flight (`encodeQueueSize`), passes each chunk to the sink in order. Output frame times use `preset.fps(project.source.fps)`.

- [ ] **Step 1 (Windows, before anything else):** in the Tauri dev window run `VideoEncoder.isConfigSupported` for the config above and log the result. If unsupported, stop and switch this task to the raw-frame fallback (canvas pixels to `ExportProcess` with `-f rawvideo -pix_fmt rgba` input instead of `-f h264`), and tell Mauricio the measured export speed.
- [ ] **Step 2: Write failing tests (`outputFrames.test.ts`):** 2 s at 30 fps with no cuts gives 60 times, first 0, last 1,966,667 (rounded us); a cut 0.5 s to 1.5 s gives 30 times with none inside the cut; all cut gives none and `refuseEmpty` returns the exact message; `youtube keeps source fps up to 60` (30 gives 30, 60 gives 60, 120 gives 60) and bitrate 12,000,000 at 60 and 8,000,000 at 30; `vertical is 1080 x 1920 at 30 fps, 6 Mbit/s`; `vertical frame rect is { x: 0, y: 656, w: 1080, h: 608 }`; a 60 fps source to the vertical preset gives half the frame times of the YouTube preset.
- [ ] **Step 3:** Run, expect FAIL. **Step 4:** Implement. **Step 5:** Run, expect PASS; `pnpm typecheck` clean.
- [ ] **Step 6: Browser check (Edge, dev page `?project=demo&export=memory`):** export the sample to the memory sink; log frames encoded, bytes, and seconds taken. Expected: frame count equals `outputDurationUs * fps / 1e6` rounded, and it runs faster than real time.
- [ ] **Step 7: Commit:** `feat(export): decode, composite and encode frames with WebCodecs`

### Task 16: Export button, Tauri sink, end-to-end checks

**Where:** design in the browser; export on Windows.

**Files:**
- Modify first: `docs/design/avant-garde/DESIGN-SYSTEM.md` (new "Export" component, below)
- Create: `apps/desktop/src/export/tauriSink.ts`, `apps/desktop/src/export/ExportStatus.tsx`, `apps/desktop/src-tauri/src/export.rs`
- Modify: top strip (Export MP4 button becomes live; remove the "Export comes in a later step" tooltip and its line in `DEVIATIONS.md`)

**Design addition (before code):** "Export" in section 6. Click Export MP4 (hotkey Ctrl+E, shown in its tooltip): a paper panel drops under the button (no shadow, 1px ink rules) with two 34px rows, each icon + label left and size in faint right: "YouTube" / "1920 x 1080, 60 fps" and "Instagram and TikTok" / "1080 x 1920, 30 fps"; the last used row is marked with the accent square; Enter picks it, Esc closes. Then the native save dialog, default `<project name> YouTube.mp4` or `<project name> Vertical.mp4` in the projects folder's `Exports` folder. While exporting, the button area shows "Exporting 42%" in mono with a Cancel button (1px paper border), and a 2px accent progress line runs along the bottom of the top strip. Editing stays possible but Export is disabled. Done: the save status slot shows the accent square + "Exported. Show in folder" (underlined link). Failed: warning bar "Export failed. <reason>. Your project is unchanged." Empty output: the button is faint with tooltip "Nothing left to export. Every part is cut."

**Interfaces:**
- Consumes: `exportProject`, `ExportSink`, `ExportProcess`.
- Produces (Rust commands): `export_begin(job: ExportJob) -> u32`, `export_chunk(id: u32, request: tauri::ipc::Request)` (raw binary body, no JSON encoding), `export_finish(id) -> ExportReport`, `export_cancel(id)`, `show_in_folder(path)`. `createTauriSink(): ExportSink` calls them.

- [ ] **Step 1:** Write the design addition; commit it alone: `docs(design): export button states`.
- [ ] **Step 2:** Implement the commands, sink and UI.
- [ ] **Step 3: End-to-end on Windows,** with the 60 s recording from Task 13 plus two cuts and the live zooms: export with both presets. Expected, checked with `ffprobe`: YouTube file H.264 High 1920 x 1080 at the source fps, vertical file 1080 x 1920 at 30 fps, both AAC 48 kHz with `moov` at the start (faststart), duration equals `outputDurationUs` within one frame; sizes at most 90 MB per minute (YouTube, 60 fps) and 45 MB per minute (vertical), written into the spike doc; both play in the Windows Media Player app. Mauricio uploads one of each as a private or draft post and says whether the text stays sharp after the platform's re-encode (not checked until he does).
- [ ] **Step 4: Preview equals export:** at three output times (inside a zoom, in a zoom ease, after a cut) grab the preview canvas (dev hook `window.__marzGrab(outUs)`) and the exported frame (`ffmpeg -ss`), compare with FFmpeg's `psnr` filter. Pass: PSNR at least 35 dB on all three (only encoder loss differs).
- [ ] **Step 5: Export sync:** export `samples/sync.marz` from Task 9 with one cut in the middle; run `pnpm sync-check <export>.mp4`. Pass: mean offset within 10 ms of the raw project's mean, spread at most one frame on both sides of the cut.
- [ ] **Step 6: Failure paths:** cancel at 50% (no `.part` left, target untouched); export to a folder without write access (warning bar with the reason); FFmpeg renamed away (warning bar "FFmpeg is missing...").
- [ ] **Step 7: Design check:** screenshots of exporting, done and failed states; `pnpm design:check`; deviations recorded.
- [ ] **Step 8: Commit:** `feat(export): export MP4 from the editor through FFmpeg`

### Task 17: Docs and status

**Where:** anywhere.

**Files:**
- Modify: `CLAUDE.md` (status: steps 4 to 6 done; Home and Recorder screens are M1; run instructions `pnpm --filter @marz/desktop app:dev`, `cargo test`, `pnpm sync-check`), `docs/design/avant-garde/README.md` (milestone column: Home and Recorder screens are M1), `docs/superpowers/specs/2026-11-15-milestone-1-design.md` (technical call 1 updated to "browser encoder, FFmpeg muxes"; goals line "Export a 16:9 MP4" extended with the YouTube and vertical letterbox presets; status line), `docs/LEARNINGS.md` (Deferred items closed: atomic write, recorder pin-downs).

- [ ] **Step 1:** Update the files. **Step 2:** `pnpm test && pnpm typecheck && cargo test --workspace && pnpm design:check` all pass.
- [ ] **Step 3: Commit:** `docs: M1 capture, shell and export status`

---

## Self-review notes

- Spec coverage: capture engine writing valid `project.marz` (Tasks 1 to 8), spike fixes kept (half-frame interval Task 7, warm-up Task 8, QPC mic padding Task 4, cursor poll Task 7), real sync check (Task 9, again on the export in Task 16), high-resolution risk (Task 9 Step 7), Tauri shell and Home (Tasks 10, 11), recorder toolbar, hotkeys, zoom presets (Tasks 12, 13), export (Tasks 14 to 16), one renderer for preview and export (Task 15 reuses `frameAt`/`drawFrame`; Task 16 Step 4 proves it).
- Format: unchanged. Live zooms are written as normal `zooms` with `origin: "live"`; pause uses the existing `pause`/`resume` lines; the crash marker is a separate file.
- Names used across tasks: `RecClock`, `Slotter`, `CfrWriter`, `FrameSink`, `MicTimeline`, `EventLog`, `ZoomPreset`, `NormRect`, `PxRect`, `ProjectMeta`, `Session`, `RecordOptions`, `SessionEvent`, `StopReport`, `ExportJob`, `ExportProcess`, `ExportSink`, `FrameSource` are each defined once.
- Not covered on purpose (parked): Window capture mode, multi-monitor spanning, system audio, camera, GPU-side encoding, bundling FFmpeg in an installer, the remaining Deferred editor items in `docs/LEARNINGS.md`.
