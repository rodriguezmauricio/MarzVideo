# Capture spike (M1 build step 4, part 1)

Date: 2026-11-16. Machine: Windows 11, i7-12700H (20 threads), RTX 3060 Laptop + Iris Xe,
1920x1080 internal screen at 165 Hz, Intel Smart Sound mic array.
Code: the spike was one throwaway file; it was replaced by the engine (`crates/capture`, Task 8 of
the capture plan) and deleted. The engine CLI reproduces the run (see "Engine run" below):

```
cargo build --release -p marz-capture
target/release/marz-capture.exe record samples/<name>.marz --secs 180 --report
```

Then `pnpm --filter @marz/desktop dev` and open `http://localhost:5173/?project=<name>`.

## Verdict

Technical calls 3 to 5 hold. `windows-capture` (WGC), `wasapi` and an FFmpeg sidecar fed raw
BGRA over stdin produce a `project.marz` folder that passes `packages/format` and plays in the
browser editor with screen, mic, waveform and the cursor drawn from `events.jsonl`.
Two changes are needed (below): a shorter WGC minimum update interval, and a warm-up before t0.

## Numbers (final 3-minute run)

Content: an Edge window redrawing at 163 fps, a scripted mouse circling and clicking, the
excluded test window on top.

| What | Result |
|---|---|
| Output frame rate | 60 fps CFR held: 10,803 frames written, 14 repeats (0.13%) |
| WGC frames delivered | 89.8/s (with a 8.3 ms minimum interval); 5 queue-full drops in 3 min |
| GPU to CPU frame copy | 4.0 ms average, 8.9 ms worst callback |
| WGC timestamp vs QPC now | 0.00 ms average, 2.3 ms worst: `SystemRelativeTime` is on the QPC clock |
| Mic drift vs QPC | 1.0 ms worst, 0.03 ms at the end of 3 min (no growth) |
| Start offsets | screen 13 ms, mic 2 ms after t0 (with warm-up) |
| CPU | capture process 29% of one core, FFmpeg 24% of one core (about 2.7% of the machine) |
| Encoder | `h264_nvenc` picked by the probe; output H.264 Main, yuv420p, 60/1 |
| Sizes | screen.mp4 2.2 Mbit/s (16.5 MB/min) on this content, 8.2 Mbit/s (61 MB/min) on full-motion `testsrc2`; mic.wav 5.8 MB/min; events.jsonl about 95 KB/min with constant mouse motion |
| Exclusions | The `WDA_EXCLUDEFROMCAPTURE` test window and the cursor are absent from the recorded frames (checked on an extracted frame). |

## What works

- **Screen (call 3):** WGC through `windows-capture` 2.0.1, `WithoutCursor`, `WithoutBorder`.
  Frame timestamps are QPC based, so they map onto the contract clock with no conversion beyond units.
- **Constant frame rate:** each WGC frame is placed in output slot `round((ts - first) / frameDur)`;
  a later frame in a filled slot is skipped (no GPU copy), empty slots repeat the last frame,
  and the end is padded to the stop time. Video length matches `durationUs` to one frame.
- **Mic (call 4):** `wasapi` 0.27 shared event mode with autoconvert to 48 kHz mono s16, written straight
  to WAV (header patched at the end). The packet `u64QPCPosition` gives the mic offset on the same clock.
- **Encoding (call 5):** FFmpeg sidecar, raw BGRA on stdin, `h264_nvenc` takes BGRA directly (no CPU
  colour conversion), fragmented MP4 (`frag_keyframe+empty_moov+default_base_moof`). Probe order
  nvenc, amf, qsv, then libx264.
- **Events:** one thread runs the low-level mouse hook and a 16 ms timer, so lines come out in time
  order. Cursor lines at most once per frame slot, only when the position changes. Coordinates are
  physical pixels relative to the captured monitor (process is per-monitor DPI aware v2).
- **Own-window exclusion:** `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` works with WGC.

## What does not work as-is (fixed in the spike)

1. **The OS default minimum update interval gives 55 fps on a 165 Hz screen.** The default (about
   16.7 ms) snaps to every third refresh (18.2 ms). Fix: request half a frame (8.3 ms at 60 fps);
   WGC then delivers about 90/s and the slotting keeps 60 CFR. On a 60 Hz screen this needs checking again.
2. **Cold start puts the mic 90 to 660 ms after t0.** The first WASAPI packet takes up to 0.7 s
   after `Start`. Fix: start mic and screen first, wait for both to deliver, then take t0 and drop
   everything before it. Offsets fell to 2 to 14 ms (the editor's 40 ms "heard twice" gap no longer triggers).
3. **The mic loses 20 ms once, 0.2 to 0.9 s after start** (every run, no discontinuity flag). The
   QPC position shows the gap; the spike pads silence so later audio stays on the clock.
4. **The low-level hook misses `SetCursorPos` moves** (scripts, remote desktop tools). The timer
   also polls `GetCursorPos`, which catches them.

## Not checked

- A real audio to video sync check (a clap or click heard in mic.wav against the event and frame).
  The clock maths says they line up within a frame; nobody has listened yet.
- 1440p, 4K or multi-monitor: raw BGRA over the pipe is 0.5 GB/s at 1080p60, 0.9 GB/s at 1440p,
  2 GB/s at 4K. Untested and the main risk for the real engine.
- A 60 Hz screen, a machine without NVENC (libx264 CPU cost), Bluetooth mics, mic unplugged mid-take.
- Pause/resume, hotkeys, the recorder toolbar.

## Pinned down for the format (no contract change)

- `durationUs` = stop time on the QPC clock minus t0. Both tracks are padded or cut to reach it.
- Mouse `button` values written: `left`, `right`, `middle` only (X buttons are not written).
- `startedAt` and `createdAt` are UTC, second precision.

## For the capture-engine plan (step 2)

- Reuse a ring of staging textures instead of the per-frame allocation inside `Frame::buffer()`,
  or keep frames on the GPU (Media Foundation or NVENC with D3D11 input) if the 1440p/4K pipe test fails.
- Pad mic gaps from the QPC position, not only from the discontinuity flag.
- Keep warm-up before t0; show "recording" only after both tracks deliver.

## Engine run (2026-11-17)

The real engine (`Session` in `crates/capture/src/win/session.rs`, CLI `marz-capture record`),
release build, same machine, `h264_nvenc` picked by the probe, 1920x1080 at 165 Hz, default mic.
Every run below passes `packages/format` (`parseProject` and `parseEvents`), and ffprobe reads
H.264 Main, yuv420p, `60/1`. Recordings are in `samples/engine-*.marz` (gitignored).

### 3-minute run (Step 2)

Content was not the same as the spike's. The machine was in use during the runs: the animated Edge
window (canvas redrawing at 166 fps, the spike's content) stayed in front for the first 25 s of
run A, then other windows covered it; in run B a small always-on-top animated window was used and
closed after 25 s. A static screen makes WGC deliver fewer frames, and the CFR writer repeats the
last frame for every empty slot, so the repeat count of these runs measures the content, not the
engine. Run A also had a scripted mouse (circling, clicking only when over the Edge window).

| What | Spike | Run A (`engine-3min`) | Run B (`engine-3min-b`) |
|---|---|---|---|
| Output | 10,803 frames, 60 fps CFR | 10,799 frames = expected 10,799, ffprobe 60/1 | 10,800 = expected 10,800, ffprobe 60/1 |
| Repeats | 14 (0.13%) | 640 (5.9%); 18 in the first 20 s (animated part), about 5 to 9 of them at start | 7,779 (72%), static screen most of the run |
| WGC frames | 89.8/s | 81/s while animated, 65.5/s overall | 82/s while animated, 27.6/s overall |
| Queue-full drops | 5 | 11, all in the first 10 s | 10 in the first 80 s, then 1,206 between 90 s and 180 s (heavy desktop use, see concerns) |
| Frame copy | 4.0 ms avg, 8.9 ms worst | 3.89 ms avg, 17.4 ms worst | 4.09 ms avg, 17.9 ms worst |
| WGC timestamp vs QPC now | 0.00 ms avg, 2.3 ms worst | 0.40 ms avg, 19.6 ms worst; stamps up to 9.5 ms ahead of now | 0.17 ms avg, 14.4 ms worst; up to 9.1 ms ahead |
| Mic drift | 1.0 ms worst, 0.03 ms at end | 0.77 ms worst, 0 at end | 0.81 ms worst, 0.06 ms at end |
| Mic gap padded | 20 ms once | 20 ms once | 20 ms once |
| Offsets | screen 13 ms, mic 2 ms | screen 14.3 ms, mic 1.5 ms | screen 6.5 ms, mic 6.1 ms |
| Warm-up | not measured | 162 ms | 159 ms |
| CPU capture process | 29% of one core | 24.9% | 18.1% |
| CPU FFmpeg | 24% of one core | 30.8% (+28%) | 38.8% (+62%) |
| Sizes | 2.2 Mbit/s | 2.15 Mbit/s, mic 5.8 MB/min, events 115 KB/min | 2.26 Mbit/s |

Holds: 60 fps CFR with the exact frame count, mic drift under 2 ms, offsets under 20 ms, capture
CPU within 20%. Not shown: repeats under 0.5% and FFmpeg CPU within 20% (content not comparable).
The browser editor opened `engine-3min` and `engine-pause` with screen, mic, waveform, the cursor
drawn from `events.jsonl` and the live zoom blocks.

Found and fixed during the run: WGC frame timestamps are up to about 9.5 ms ahead of QPC now
(the frame's present time), so frames one or two slots past the stop time can already be queued
when the stop time is read. The writer wrote one frame too many (180 for an expected 179). It now
holds three slots back (`writer::HOLD_SLOTS`), and every run since matches the expected count.

### Pause (Step 3)

`--secs 60 --pause-at 0.5,20,40 --resume-at 5,25 --zoom-at 8,12,30`: pauses 0.5 to 5, 20 to 25,
and 40 to the stop (stopped while paused). Wall 60.003 s, paused 29.500 s, wall minus paused
30.503 s; `durationUs` 30,503,063. Video 1,829 frames (ffprobe) for `durationUs` minus the 14.4 ms
screen offset = 1,829.3 frames. Events: `pause`/`resume` at 503,126 and at 15,504,701 (equal
`tUs`), last `pause` at 30,503,063. mic.wav 30.5029 s plus 0.2 ms offset = `durationUs`. Two live
zoom blocks (3.50 to 7.50 s and 20.50 s to the end) on the pause-adjusted clock.

### Region (Step 4)

`--secs 10 --region 101,101,1001,563`: `source` 1000 x 562 (width and height rounded down to even),
ffprobe 1000 x 562, 599 frames. A frame at 5 s matches a desktop screenshot cropped to
(101, 101, 1000, 562). Cursor moved by script to (101, 101) then (601, 401): events show
`x 0, y 0` and `x 500, y 300`.

### Crash (Step 5)

`--secs 60`, killed with `taskkill /F` 20.4 s after recording started. The `.recording` marker
held the real offsets (screen 17.5 ms, mic 8.3 ms, rewritten after the first frame and packet).
`marz-capture recover samples/engine-crash.marz`: `durationUs` 20,320,000 (the shorter track),
screen 1,222 frames, WAV header patched, marker removed; a second `recover` says nothing to do.
The project passes `packages/format`.

### Mic loss (Step 6)

Simulated: `--secs 30 --simulate-mic-loss-at 10` makes the mic thread take the same path as a
device error (warning, clean stop, padding at stop). Printed "Microphone disconnected. Recording
continues without sound." at 10 s; the recording continued; mic.wav 30.0004 s plus 5.0 ms offset =
`durationUs` 30,005,355 (20.01 s of end padding); after 10.2 s the file is digital silence.
Not checked: a real unplug or disabling the device in Sound settings (needs Mauricio).

### Open points

- Repeat rate and FFmpeg CPU on the spike's content need one clean 3-minute run with nobody using
  the machine: open an animated page full screen, then
  `target/release/marz-capture.exe record samples/clean-3min.marz --secs 180 --report`.
- Under heavy desktop use (run B, 90 s on) the writer queue filled about 13 times a second while
  WGC delivered only about 20 frames a second: the raw pipe to FFmpeg stalls when the machine is
  busy. This is the pipe risk from "Not checked" above; Task 9's pipe check measured the pipe itself (see "Pipe check"): at 1080p and 1440p it never stalls in steady state, so the run B stalls most likely came from the machine being busy (CPU and GPU contention), not from the pipe alone. Not proven.
- About 5 to 9 repeats and 10 to 13 queue-full drops in the first second of every run (FFmpeg opens
  the encoder on the first frame). Small over a long recording, visible as a short hitch at the start.

## Sync check (Task 9, 2026-11-17)

Built: `tools/sync-check` (`pnpm sync-check <folder.marz | file.mp4> [--mode flash|click] [--latency-ms N]`)
and `marz-capture record ... --sync-probe` (black window over the monitor that turns white for 100 ms
and plays a 1 kHz 100 ms beep every 3 s from 2 s in; writes `sync-probe.json` beside the project with the
render latency). Flash detection: mean luma of each frame (`scale=1:1,format=gray`) jumps from below 40 to
above 200. Beep detection: 2 ms RMS window above 8 times the median RMS of the preceding 200 ms, refined to the
first loud sample. Audio for `mic.wav` and for an MP4 goes through one path: `ffmpeg -f s16le -ac 1 -ar 48000`.

Checked here (no screen, no sound): the analyzer unit tests (flashes at frames 30 and 210 at 30 fps,
a beep at 1.000 s in noise within 1 ms, pairing, verdicts) and the analyzer on a generated sample
(`makeSample` with `syncOffsetMs` 0 reads 0.0 ms, with 30 reads 30.0 ms, spread 0.0 ms, 20 of 20 pairs on a
63 s sample; an MP4 with the sound muxed in is read the same way). The probe compiles and its
JSON and beep generator are unit tested. **The probe itself and a real recording have not been run:**
the PC was in use, and the probe flashes the whole screen and plays sound. Not checked: any real sync
number, the click test, the listen check. Commands and pass criteria: `docs/spikes/2026-11-17-owner-checks.md`.

What the printed latency covers: stream latency from `GetStreamLatency`, plus the time the trigger
waited for the audio thread, plus the frames already queued in the render buffer. It does not include
the speaker path or the mic input path, so a mean a few ms off the printed latency is expected; the
mean absolute offset (45 ms) and spread (17 ms) limits are the ones that matter.

## Pipe check (Task 9, 2026-11-17)

`target/release/pipe-bench.exe`: synthetic BGRA frames (a scrolling gradient with noise, four patterns cycled)
written into `ScreenEncoder` with the recorder's own FFmpeg arguments, 20 s per size, 60 fps target,
`h264_nvenc`. Frame i is due at i / 60 s; a slow encoder fills the pipe, the write blocks and the rate falls.
Same machine (i7-12700H, RTX 3060 Laptop), **Mauricio was using it during every run**, so read these as
worst-ish case. CPU is percent of one core (20 threads).

| Size | Run | Sustained fps | Worst write | Writes later than one slot | Bench CPU | FFmpeg CPU | Output |
|---|---|---|---|---|---|---|---|
| 1920x1080 | 1 | 60.04 | 150.8 ms | 10 of 1200 | 9% | 21% | 9.5 Mbit/s |
| 1920x1080 | 2 | 60.04 | 250.9 ms (3.9 ms after the first second) | 18, none after the first second | 9% | 28% | 9.5 Mbit/s |
| 2560x1440 | 1 | 60.04 | 235.4 ms | 20 of 1200 | 15% | 48% | 13.6 Mbit/s |
| 2560x1440 | 2 | 60.04 | 256.0 ms (5.0 ms after the first second) | 24, none after the first second | 14% | 51% | 13.6 Mbit/s |
| 3840x2160 | 1 | 60.02 | 429.0 ms | 153 of 1200 | 29% | 104% | 25.1 Mbit/s |
| 3840x2160 | 2 | **56.39** | 389.8 ms (26.5 ms after the first second) | 1,198 (1,140 after the first second) | 55% | 145% | 23.6 Mbit/s |
| 3840x2160 | 3 | 59.75 | 387.4 ms (22.7 ms) | 909 (851) | 49% | 140% | 25.0 Mbit/s |
| 3840x2160 | 4 | 58.88 | 373.8 ms (23.0 ms) | 1,145 (1,087) | 50% | 142% | 24.6 Mbit/s |

(Run 1 was made before the "after the first second" columns existed.) The first 150 to 430 ms stall in every row is
FFmpeg opening the encoder on the first frame, the hitch every recording has at its start.

Verdict: **1440p at 60 fps holds** with a wide margin (no write later than one slot after the first second,
worst steady write 5 ms). **4K at 60 fps does not hold steadily**: two of four runs were under 98% of the target
(56.4 and 58.9 fps), and in every run most frames were written one to two slots late, which means the pipe
(about 2 GB/s) is the limit. The real recorder drops frames when its queue fills, so 4K at 60 would show as
drops and repeats. Result: capture above 2560 x 1440 pixels is capped at 30 fps (`region::check_fps`, called
from `Session::start`; the message is "This screen records at 30 fps"). The area is the captured region, so a
small region on a 4K screen still records at 60. The GPU path (Media Foundation or NVENC with D3D11 input) is
parked, not built in M1. The 4K cap follows the plan's "1440p or 4K fails" rule. The 1440p criterion alone would not have triggered it.

Not checked: 4K or 1440p through the real engine (this machine's screen is 1080p), libx264 at these sizes
(the machine has NVENC; a CPU encoder would be much slower), a second monitor.

## Export sizes (Task 16, 2026-11-17)

A fresh 60.8 s region recording (1280 x 720 at 60 fps, two live zooms, two 2 s cuts, 56.8 s out), exported from the dev app through FFmpeg:

| Preset | Video | Audio | Size | Per minute | Limit | Export time |
|---|---|---|---|---|---|---|
| YouTube | H.264 High 1920 x 1080, 60 fps, 3,408 frames | AAC LC 48 kHz mono | 14.2 MB | 15.0 MB | 90 MB | 26.7 s |
| Instagram and TikTok | H.264 High 1080 x 1920, 30 fps, 1,704 frames | AAC LC 48 kHz mono | 5.0 MB | 5.3 MB | 45 MB | 23.5 s |

Both have `moov` before `mdat` (faststart). Durations 56.801 and 56.799 s against `outputDurationUs` 56.787 s: inside one frame. The content was a mostly still screen; busy screens use more of the 12 / 6 Mbit/s budget (engine-3min in Task 15: 40 MB per minute at 60 fps).

