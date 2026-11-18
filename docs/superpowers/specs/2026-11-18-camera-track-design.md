# Camera track design

Status: **draft, waiting for Mauricio's yes** on the format change, the design and the open questions
below. No code until then.

Asked by Mauricio (2026-11-18): "Is it capturing cameras? One of the big features is separated layers
for cameras and screen and the flexible AI editing", then "Yes, plan it".

## Goal

Record a webcam into its own file, `camera.mp4`, in the `.marz` folder, never burned into
`screen.mp4`, on the same clock as screen, mic and computer sound. The editor shows it as its own
lane and puts it on the picture as a simple picture-in-picture (PiP) that preview and export both
draw. Layout scenes, masks and motion paths (product spec section 7) are a later step; the data
shape here is ready for them.

## What he gets

- Setup bar: the dashed "Camera / Not in this version" item becomes a working camera picker plus an
  on/off toggle (same style as the mic picker and the Hide cursor toggle). Off by default, remembered.
- While the camera is on during setup, a live preview of it sits on the overlay where the PiP will
  be, so he can check framing and light before Record (question 1).
- Recording: `camera.mp4` next to `screen.mp4`. The camera is never in `screen.mp4`.
- Editor: the Camera lane (today a dashed "Later" lane) shows camera thumbnails like the Screen lane.
  The preview and the export show the camera in a corner. The inspector's Project panel gets a
  Camera section: show or hide, corner, size.

## Out of scope (later step, data shape ready)

Layout scenes, scene switching hotkeys, masks (circle, rounded rect, custom), motion paths, camera
fullscreen, side column, the 9:16 camera slot in vertical export, background removal, two cameras.

## Facts from this PC (read 2026-11-18, before any spike)

- Cameras: "Integrated Webcam" (USB) and "DemoCreator Virtual Camera" (a DirectShow virtual camera).
- Integrated Webcam modes: MJPEG 1280 x 720 at 30 fps, 640 x 480 at 30, 640 x 360 at 30; raw YUY2
  only up to 640 x 480 at 30 (1280 x 720 raw is 10 fps). So 720p30 needs MJPEG, which has to be
  decoded before encoding.

## Technical calls (Claude's, open to correction)

1. **Media Foundation Source Reader** (`IMFSourceReader`) on the chosen camera, with
   `MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING` so Windows decodes MJPEG and hands NV12 frames.
   No new crate: only more features of the `windows` crate we already use
   (`Win32_Media_MediaFoundation`). Runs on its own thread in `crates/capture/src/win/camera.rs`.
2. **Mode choice:** the highest mode at or below 1920 x 1080 that reaches 30 fps (720p30 MJPEG on this
   PC). Never above 30 fps; 30 is plenty for a face and halves the encoder load.
3. **Clock:** Media Foundation capture sample times are on the system clock (QPC in 100 ns), like
   WGC and WASAPI. Spike check 1 confirms that, and measures the camera's own delay (USB cameras are
   often 50 to 150 ms late). The measured delay is subtracted so the face lines up with the voice.
4. **Encode:** a second FFmpeg sidecar, NV12 on stdin, `h264_nvenc` with `libx264 veryfast` fallback,
   no B-frames, fragmented MP4, constant 30 fps through the same frame slotting as the screen
   (`slots.rs`, `writer.rs`). 720p30 NV12 is about 41 MB/s through the pipe, a fifth of a 1440p60
   screen, and consumer NVIDIA cards allow several NVENC sessions. Spike check 2 measures it next to
   a 1440p60 screen recording.
5. **Warm-up:** the camera joins the warm-up wait before t0 (max 3 s, like screen and mic). If it
   does not deliver, the recording starts without it and says so ("The camera did not start.
   Recording without it."), never failing the take. Same if it stops mid-take (unplugged, taken):
   `camera.mp4` keeps what it has, the rest is padded with the last frame, and a warning shows.
6. **Camera in use by another app:** Windows 11 can share a camera between apps through the frame
   server, but some drivers refuse. Spike check 3 opens it while Teams or a browser holds it. If it
   fails, the setup bar shows "This camera is used by another app. Close it or pick another camera."
7. **Setup preview:** the overlay page shows the camera through WebView2 `getUserMedia` while setting
   up, and releases it before Record so the engine can open it. No engine frames go to the webview.
8. **Mirror:** the raw file is never mirrored. The PiP is drawn mirrored by default (how people expect
   to see themselves); a project setting turns it off (question 2).
9. **Virtual cameras:** DirectShow-only virtual cameras (DemoCreator, older OBS) are not visible to
   Media Foundation. Not supported in this step (question 4).
10. **Export:** the export already decodes `screen.mp4` with WebCodecs in the webview. It decodes
    `camera.mp4` the same way and the compositor draws the PiP on each output frame, so preview and
    export stay one renderer. Memory: about 5 MB per minute of 720p camera video, fine.

## Format change (project.json, stays version 1, additive)

New optional track, same style as `tracks.system`:

```json
"tracks": {
  "camera": { "file": "camera.mp4", "offsetUs": 41000, "width": 1280, "height": 720, "fps": 30 }
}
```

`offsetUs` is when the first camera frame was taken on the recording clock, after the measured camera
delay. New optional edits block (missing = defaults below):

```json
"edits": {
  "camera": {
    "visible": true,
    "mirror": true,
    "pip": { "corner": "bottomRight", "widthFrac": 0.22, "marginFrac": 0.03, "shape": "rect" },
    "scenes": []
  }
}
```

- `pip` is the default layout for the whole video. `corner` is `topLeft`, `topRight`, `bottomLeft` or
  `bottomRight`; `widthFrac` is the camera width as a share of the output width (S 0.16, M 0.22,
  L 0.30); `marginFrac` the gap to the edges; `shape` is only `rect` now (the design system has no
  rounded shapes; masks come later).
- `scenes` is reserved for timed layout scenes (`{ id, startUs, endUs, layout }`), always `[]` now.
  Older builds keep it untouched (unknown fields are preserved on save).
- The camera picture keeps its aspect ratio and is never cropped in this step.
- Zooms act on the screen only; the PiP stays put while the screen zooms.
- Vertical export (1080 x 1920 letterbox): the PiP sits in the same corner of the 16:9 frame. The
  camera's own slot above or below comes with auto-reframe, later.

Crash recovery: `camera.mp4` is fragmented like the screen, so a killed take keeps it; recovery reads
its length with ffprobe and its offset from the crash marker (rewritten once the first frame lands).

## Design (DESIGN-SYSTEM.md is updated first, in the same style, when building)

- **Setup bar, Camera item:** camera icon, picker (the mic picker's 1px line box with chevron,
  "Integrated Webcam"), toggle (the Hide cursor toggle). The dashed "Not in this version" tag goes.
  With no camera: "No camera", toggle disabled.
- **Overlay preview (setup only):** the live camera at the PiP's place and size inside the region,
  1px paper border, no radius, no shadow, label tag above it like a zoom preset tag ("Camera"). Not
  draggable in this step (corner and size are picked in the editor).
- **While recording:** nothing new on the overlay (the camera is not drawn on screen while recording,
  so it never covers what is being recorded). The recording bar gets no new button.
- **Timeline:** the Camera lane becomes a real lane in its Later slot (like System audio): thumbnail
  strip at 22 px (44 expanded), label in paper. Without a camera it stays a Later lane.
- **Preview and export:** the PiP is drawn with a 1px paper border, no radius, no shadow.
- **Inspector, Project panel:** a "Camera" block under the existing toggles: "Show camera" toggle,
  "Mirror" toggle, corner picker (four 22 px squares in a 2 x 2, selected = ink fill), size segmented
  control S / M / L (the Motion row's segmented style). Only when the project has a camera.

## Spike first (half a day, on this PC)

1. Clock: camera sample times vs QPC, and the camera delay (point the camera at the screen during a
   `--sync-probe` run: the flash shows up in both `screen.mp4` and `camera.mp4`).
2. Load: camera 720p30 plus screen 1440p60 on NVENC at once; screen must still hold 60 fps.
3. Busy camera: open it while Teams or Edge (a Meet tab) uses it; record what Windows returns.
4. Formats: MJPEG to NV12 through the Source Reader; CPU cost of the decode.

Findings go into `docs/spikes/2026-11-19-camera-spike.md`. A failed check changes this design before
building.

## Estimate

About 4 to 5 working days of Claude sessions, in 3 steps: spike (half a day), engine and format (2 days),
editor, preview, export and setup bar (2 days), checks on Windows (half a day). Anchor: computer sound
took one session for the same pattern with no video; the camera adds a second video pipeline in the
engine and a second decoded video in preview and export.

## Questions only Mauricio can answer

1. Live camera preview on screen during setup? (Recommended: yes. Framing and light are checked before
   the take, and it costs little.)
2. Camera mirrored by default in the video? (Recommended: yes. People expect to see themselves like
   in a mirror; the raw file is never mirrored, so it can be flipped later.)
3. Default PiP: bottom right, medium (22% of the width), plain rectangle? (Recommended: yes. A circle
   or rounded mask comes with the masks step.)
4. Do you record with a virtual camera (OBS Virtual Camera, DemoCreator)? (Recommended: not in this
   step. They need a separate capture path; the built-in webcam works now.)
5. Approve the format change above (`tracks.camera` and `edits.camera`, both optional, version stays 1)?
