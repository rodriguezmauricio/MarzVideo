# Camera spike (camera track plan, Task 0)

Date: 2026-11-18 (evening). Machine: as in the capture spike (i7-12700H, RTX 3060 Laptop, 1920 x 1080
screen). Camera: "Integrated Webcam" (USB, vid 0c45 pid 6a14).
Code: `crates/capture/src/bin/camera-spike.rs` (`camera-spike list`, `camera-spike read <secs>
[--encode out.mp4]`). Throwaway: Task 1 replaces it with `src/win/camera.rs` and deletes it.

## Verdict

The design holds. Media Foundation opens the webcam with no new crate (only the
`Win32_Media_MediaFoundation` feature of `windows`), frame times are on the shared QPC clock, a
second NVENC encode does not hurt the screen recording, and a camera held by another app fails with
a clear error. Two changes to the plan, both small: the camera often delivers fewer than 30 frames
per second, and its own delay has to come from an owner check, not from this spike.

## Findings

1. **Modes.** Media Foundation lists NV12 1280 x 720 at 30 fps directly (the Windows frame server
   decodes the camera's MJPEG for us), plus MJPEG and YUY2 modes. The rule "highest mode at or below
   1080p that reaches 30 fps, NV12 first" picks NV12 720p30. No MJPEG decode in our code.
2. **Virtual camera.** "DemoCreator Virtual Camera" (DirectShow) is not listed by Media Foundation,
   as expected. Not supported in this step (approved).
3. **Clock.** The sample time from `ReadSample` equals `MFSampleExtension_DeviceTimestamp`, and both
   are QPC in 100 ns units, the clock WGC and WASAPI use. Frames reach our thread about 34 ms after
   that timestamp (mean 31.6 to 33.7 ms, max 40 to 140 ms in the first frames). So the engine stamps
   frames with the device timestamp, not the arrival time.
4. **Start time.** 720 to 810 ms from opening the camera to its first frame. The warm-up wait
   (max 3 s) covers it.
5. **Frame rate.** The camera delivered 17.9 to 19.3 fps, not 30, in an evening room (frames 48 to
   64 ms apart). Webcams lower their frame rate in dim light to expose longer ("exposure priority").
   The constant 30 fps writer repeats frames to fill, as the screen writer does, so the file is
   still 30 fps and in sync. Plan change: Task 1 also tries to turn exposure priority off
   (`IAMCameraControl` / `KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY`) when the driver allows,
   and the report prints the real camera fps. **Dropped in Task 1:** with exposure priority off the
   Integrated Webcam kept 27 fps but the picture was almost black, and the setting stayed in the camera
   for every app (it was set back to 1). The engine leaves it alone.
6. **Load.** 15 s full-screen 1080p60 recordings, alone and with the camera encoding 720p NV12 to
   `h264_nvenc` at the same time: the screen wrote every expected frame both times (898 and 899),
   no queue drops, GPU copy 3.0 vs 3.7 ms average, FFmpeg CPU 22.6% vs 31.2% of one core (that
   includes the camera's FFmpeg). Screen content differed between the runs, so repeat counts are not
   comparable (see LEARNINGS 2026-11-17).
7. **Camera in use.** Whoever opens the camera first keeps it. A second opener gets the device and a
   media type, but its first `ReadSample` fails with `0xC00D3704` ("Hardware MFT failed to start
   streaming due to lack of hardware resources"); FFmpeg via DirectShow as the second opener gets no
   frames. Our recording keeps running when another app tries later. The engine maps `0xC00D3704`
   to "This camera is used by another app. Close it or pick another camera." at warm-up.
8. **Encoded file.** NV12 piped to `h264_nvenc` (no B-frames, fragmented MP4) plays as H.264
   1280 x 720 at 30/1.

## Not measured here: the camera's own delay

The device timestamp is set by the driver when the frame is delivered, so it does not include the
sensor's exposure and USB time (often 50 to 150 ms on webcams). Measuring it needs the camera to
see an event that is also in another track. The laptop camera faces the user, not the screen, so
the `--sync-probe` flash cannot be used. Plan change: Task 5's owner check (a clap on camera, heard
on the mic) measures it once; until then the offset uses the device timestamp with no extra delay,
and a later fix sets a constant per camera if the clap shows a gap.
