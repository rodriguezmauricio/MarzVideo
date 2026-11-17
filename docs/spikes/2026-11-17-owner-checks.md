# Checks that need Mauricio at the PC (2026-11-17)

Six checks the engine work could not run without taking over the screen, the speakers or the
mouse. Each one is a block: what it proves, the exact commands, what PASS looks like. Paste the
output of each back to Claude.

Run everything from the repo folder (`C:\Users\conta\Desktop\MarzRecorder\.claude\worktrees\capture-plan-d523b6`,
or wherever this branch is checked out). Build once first:

```
cargo build --release -p marz-capture
```

The recorder is then `target\release\marz-capture.exe`.

---

## 1. Clean 3-minute run (nobody at the PC)

Proves: frame repeats and FFmpeg CPU on the spike's content. The earlier runs were on a busy machine.

1. Close everything. Open an animated page full screen in Edge (a canvas or WebGL demo that redraws all the time).
2. Start the run, then take your hands off the keyboard and mouse for 3 minutes:

```
target\release\marz-capture.exe record samples\clean-3min.marz --secs 180 --report
```

PASS: `written frames` equals `expected` (10,799 or 10,800), `repeats` under 0.5 %,
`mic drift` under 2 ms, both `offsetUs` under 20 ms, `cpu ffmpeg` within 20 % of the spike (24 % of one core).
The same numbers are saved in `samples\clean-3min.marz\capture-report.txt`.

---

## 2. Flash and beep sync run

Proves: sound and picture line up within a frame. This covers the whole screen with a black
window that flashes white and beeps every 3 seconds for 63 seconds.

1. Turn the speakers up to a normal level. Put the laptop where its mic hears the speakers (do not use headphones).
2. Leave the PC alone for the whole minute (do not touch the mouse, it would hit the flashing window).
3. Run:

```
target\release\marz-capture.exe record samples\sync.marz --secs 63 --sync-probe
pnpm sync-check samples\sync.marz
```

The recorder prints the render latency of the sound engine. `pnpm sync-check` prints PASS or FAIL.

PASS (all four lines say `ok`):

- 20 or more flash and beep pairs found (21 are made),
- spread at most 17 ms (one frame at 60 fps),
- mean absolute offset at most 45 ms (the point where people start to notice),
- mean within 10 ms of the render latency the recorder printed.

Then the listen check (1 minute): `pnpm --filter @marz/desktop dev`, open `http://localhost:5173/?project=sync`,
play it. PASS: the flash and the beep land together.

If the last line fails but the first three are ok, send both numbers: the mean is real, the
printed latency only covers the sound engine, not your speakers.

---

## 3. Ten-click test

Proves: a mouse click event and the click sound it makes are on the same clock.

1. Put the mouse right next to the laptop mic. Use a mouse with a loud click.
2. Run, and during the 30 seconds click 10 times, hard and spaced out (about 2 seconds apart, not double clicks):

```
target\release\marz-capture.exe record samples\clicks.marz --secs 30
pnpm sync-check samples\clicks.marz --mode click
```

PASS: `click to sound` shows 8 or more pairs (10 are made) and a mean absolute offset of at most 20 ms. `PASS` on the last line.

---

## 4. Real static-screen check (5 seconds, hands off)

Proves: a screen that never changes still gives a full-length video (the engine writes the first frame itself).

1. Show a still desktop: close or minimise anything that moves, no video, no clock animation, mouse parked in a corner.
2. Hands off, then run:

```
target\release\marz-capture.exe record samples\static-real.marz --secs 5 --no-mic --report
```

PASS: `written frames` equals `expected` (about 299), the run ends with no error, and the file plays:
`ffprobe -v error -show_entries stream=nb_frames,r_frame_rate -of csv=p=0 samples\static-real.marz\screen.mp4` prints `60/1` and the same count.
Almost all of them are repeats; that is fine here.

---

## 5. Real mic unplug

Proves: pulling the mic mid-take keeps the recording going and the sound file stays the right length.

1. Use a USB mic or headset if you have one. If not, you will disable the laptop mic in Settings during the run
   (Settings, System, Sound, Input, pick the mic, Disable) and enable it again afterwards.
2. Start the run. At about 10 seconds, unplug or disable the mic. Leave it off until the run ends:

```
target\release\marz-capture.exe record samples\micloss-real.marz --secs 30 --report
```

PASS: the screen prints `Microphone disconnected. Recording continues without sound.`, the recording runs to 30 s,
and `mic samples` in the report is about 30 s (`end padded` roughly 20 s). The project opens in the editor
(`http://localhost:5173/?project=micloss-real`) with a flat mic track after about 10 s. Plug the mic back in afterwards.

---

## 6. The 60 Hz rerun

Proves: the 8.3 ms minimum update interval fix (made on a 165 Hz screen) also holds on a 60 Hz screen.

1. Settings, System, Display, Advanced display, set the refresh rate to 60 Hz.
2. Put the animated Edge page back on screen full screen, hands off, and run:

```
target\release\marz-capture.exe record samples\hz60.marz --secs 30 --report
```

3. Set the refresh rate back to 165 Hz.

PASS: the first line prints `@ 60 Hz`, `written frames` equals `expected` (1,799 or 1,800), `repeats` under 0.5 %,
and `wgc frames` is at least 55 per second. If WGC frames are well under 60 per second, send the report: the
minimum update interval needs a different value on 60 Hz screens.
