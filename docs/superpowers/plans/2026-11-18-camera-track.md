# Camera Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** approved by Mauricio on 2026-11-18 with the recommended picks
(`docs/superpowers/specs/2026-11-18-camera-track-design.md`). Start with Task 0.

**Goal:** Record a webcam into `camera.mp4` on the shared clock, show it as its own lane, and draw a
default picture-in-picture in preview and export.

**Architecture:** Same pattern as the computer-sound track (commit f7a9194): an optional capture
thread in `Session`, an optional track in `project.json`, a lane that replaces its Later slot, and
the compositor drawing one more layer. Video goes through a second FFmpeg sidecar fed by the same
frame slotting as the screen.

**Tech stack:** Rust, `windows` 0.62 with `Win32_Media_MediaFoundation` (no new crate), FFmpeg
sidecar, React/TS, WebCodecs, `mp4box`, Vitest, Edge via Playwright and CDP on the real app.

## Task 0: Spike (half a day)

- [ ] `crates/capture/src/bin/camera-spike.rs` (deleted after): list Media Foundation cameras and
  their modes, open the Integrated Webcam at MJPEG 720p30 with advanced video processing, read NV12.
- [ ] Clock: log sample time vs `qpc_hns()` for 300 frames; record a `--sync-probe` take with the
  camera pointed at the screen and measure the flash in both files. Write the camera delay.
- [ ] Load: pipe 720p30 NV12 into `h264_nvenc` while a 1440p60 screen take runs; screen must keep 60 fps
  (`capture-report.txt` repeat counts as in the capture spike).
- [ ] Busy: open the camera while Edge (Meet tab) holds it; record the HRESULT and the behavior.
- [ ] Write `docs/spikes/2026-11-19-camera-spike.md`. Stop and tell Mauricio if a check fails.

Task 0 done 2026-11-18: `docs/spikes/2026-11-19-camera-spike.md`. Design holds. Changes: NV12 720p30
comes straight from Media Foundation (no MJPEG decode); stamp frames with the device timestamp; try to
turn exposure priority off (dim rooms gave 18 to 19 fps); map `0xC00D3704` to "camera used by another
app"; the camera's own delay is measured by the owner clap check, not the spike.

## Task 1: Engine, camera capture (`crates/capture`)

- [ ] `src/win/camera.rs`: `list_cameras()` (id, name, best mode), `start(id, slot_sender, shared)`
  on its own thread, NV12 frames stamped on the recording clock minus the measured delay, warm flag,
  lost flag plus warning, stop.
- [ ] `src/ffmpeg.rs`: `camera_args(encoder, w, h, fps, out)`: `-f rawvideo -pix_fmt nv12`, no B-frames,
  fragmented MP4. Unit test on the argument list.
- [ ] Reuse `slots.rs` and `writer.rs` for constant 30 fps with last-frame padding; a camera that
  stops pads to the end.
- [ ] `src/win/session.rs`: `RecordOptions.camera_id: Option<String>`; start after the mic, join the
  warm-up; on failure record without it and warn ("The camera did not start. Recording without it.").
  Stop order: camera after screen, before mic.
- [ ] `src/project.rs`: `ProjectMeta.camera: Option<CameraMeta { offset_us, width, height, fps }>`
  (serde default), `project_json` writes `tracks.camera`; crash marker rewrite includes its offset.
- [ ] `src/recover.rs`: keep `camera.mp4` when it has packets, length by ffprobe like the screen.
- [ ] CLI `--camera-id ID` and `--list-cameras`.
- [ ] Tests: project JSON with and without camera, recovery with a camera file, slotting of a camera
  that stops early. Real check on Windows: a 30 s CLI take with the camera, both files play, lengths
  equal within one frame.

## Task 2: Shell and setup bar

- [ ] `recording.rs`: `RecordOptionsDto.camera_id` (serde default None) through `Plan` into the session.
- [ ] `recorder.rs`: `list_cameras` command; `Setup` includes cameras.
- [ ] `recorderStore.ts`: `cameraId`, `cameraOn` (older saved setups read as off); `recordOptions`.
- [ ] DESIGN-SYSTEM.md first (Camera item, overlay preview), then `SetupBar.tsx` picker and toggle,
  and the overlay preview (`getUserMedia` with the matching device, released before Record).
- [ ] Errors on the error line: camera in use, no camera.
- [ ] Tests: store load/save, recordOptions. Check: 1440 x 900 fake page screenshot vs the design;
  real app take with the camera on (CDP as in the computer-sound check).

## Task 3: Format and editor

- [ ] `packages/format`: optional `tracks.camera` and `edits.camera` (defaults when missing, unknown
  fields kept). Tests for parse, defaults, round trip.
- [ ] `packages/compositor`: `cameraRect(project, output)` (corner, width share, margin, aspect kept)
  and drawing the camera frame (mirrored when set) with a 1px paper border after the screen and
  cursor. Tests on the rect for every corner and size, 16:9 and vertical output.
- [ ] `Preview.tsx`: a second hidden `<video>` for `camera.mp4`, synced like the audio (offset, drift
  correction), drawn through the compositor.
- [ ] `Timeline.tsx`: Camera lane in its Later slot with `ScreenThumbs` from `camera.mp4`.
- [ ] `Inspector.tsx`: Camera block (Show camera, Mirror, corner, size), undoable edits.
- [ ] Browser checks against the sample project with a synthetic `camera.mp4` from `tools/make-sample`.

## Task 4: Export

- [ ] `apps/desktop/src/export`: decode `camera.mp4` with WebCodecs next to the screen (same raw cts
  mapping as the screen) and pass the camera frame to `drawFrame` for each output frame.
- [ ] Tests: export frame matches preview frame with the PiP (the existing PSNR check), vertical preset
  keeps the PiP inside the 16:9 frame.
- [ ] Real export on Windows of the Task 1 take, both presets; play in Windows Media Player.

## Task 5: Docs and checks

- [ ] M1 spec format section, DESIGN-SYSTEM.md, DEVIATIONS.md, LEARNINGS.md, CLAUDE.md status.
- [ ] `cargo test --workspace`, `pnpm test`, `pnpm typecheck`, `pnpm design:check`.
- [ ] Owner check for Mauricio: one real take with face, voice and a clap; the clap lines up.
