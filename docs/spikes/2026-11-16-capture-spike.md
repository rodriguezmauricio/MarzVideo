# Capture spike (M1 build step 4, part 1)

Date: 2026-11-16. Machine: Windows 11, i7-12700H (20 threads), RTX 3060 Laptop + Iris Xe,
1920x1080 internal screen at 165 Hz, Intel Smart Sound mic array.
Code: `crates/capture` (throwaway, one file). Run it:

```
cd crates/capture && cargo build --release
target/release/marz-capture.exe ../../samples/<name>.marz --secs 180
```

Then `pnpm --filter @marz/desktop dev` and open `http://localhost:5173/?project=<name>`.
Flags: `--fps N`, `--encoder NAME`, `--min-interval-us N` (0 = OS default), `--no-test-window`.

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
