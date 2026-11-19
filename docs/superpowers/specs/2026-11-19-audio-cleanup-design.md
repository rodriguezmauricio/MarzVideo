# Audio cleanup: design (2026-11-19)

Product spec section 9. Built overnight on the owner's pre-approval; he reviews at test time.

## What the owner gets

1. **Mic and computer sound on their own controls** in the inspector (Project panel, "Audio" block):
   volume (0 to 100%), mute, and a fade in / fade out length (Off, 0.5 s, 1 s, 2 s) per track.
   Preview and export both follow them.
2. **Noise removal for the mic**, local, on by default, one switch. Heard in preview (the app plays a
   cleaned copy) and used by the export. `mic.wav` is never touched.
3. **Even loudness at export**: the mixed sound is brought to about -14 LUFS (YouTube's level),
   true peak at most -1.5 dB. On by default, one switch. Export only (preview plays the plain mix).

Left out: filler-word removal (the AI edit does it), camera layouts, captions.

## Format (`project.json`, version stays 1)

Volume and mute already live on `tracks.mic` / `tracks.system` (`volume`, `muted`); they are now
editable. New, optional:

```json
"edits": {
  "audio": {
    "denoise": true,
    "normalize": true,
    "mic":    { "fadeInUs": 0, "fadeOutUs": 0 },
    "system": { "fadeInUs": 0, "fadeOutUs": 0 }
  }
}
```

- Missing `edits.audio` (or a missing key in it) means the defaults above: noise removal and even
  loudness on, no fades. So older projects get both on at their next export.
- Fades are in output time: fade in from the start of the exported video, fade out to its end,
  linear (FFmpeg `afade` default curve), per track, after the track's volume.
- Volume is stored as a gain (1 = 100%). The editor offers 0 to 100% in 5% steps; values above 1
  from elsewhere are kept and used by export (preview caps at 100%).

**Derived files** (regenerable, never edited by hand, may be deleted at any time):

```
cache/mic.clean.wav    the mic after noise removal: same length and rate as mic.wav, mono 16-bit
cache/mic.clean.json   { "version": 1, "filter": "<ffmpeg filter>", "mic": { "bytes", "modifiedMs" } }
```

The stamp says which `mic.wav` (size and modified time) and which filter made it. A stale or missing
stamp means the copy is made again. Raw tracks stay untouched.

## Noise removal

FFmpeg, no download: `highpass=f=80,afftdn=nr=20:nf=-50:tn=1` (rumble cut below 80 Hz, FFT denoiser
with noise tracking). Same sample count in and out (checked), so sync holds.

Measured (2026-11-19, `docs/LEARNINGS.md`):
- Synthetic 300 Hz tone with pink noise: tone level held (-31.4 to -31.5 dBFS), noise in the gaps
  6.4 dB lower (-47.6 to -54.0).
- His real take (copy of "AI test 19.35", first 2 minutes): speech level held (-20.9 to -20.7 dBFS at
  the 90th percentile), noise floor 9.5 dB lower (-72.8 to -82.4). His mic is already quiet.
- Speed: 8 minutes of mic cleaned in about 2 s.

Better quality needs a speech model: FFmpeg `arnndn` with an RNNoise model file (about 100 KB) or
DeepFilterNet (larger, separate runtime). Both need a download, so they wait for the owner's yes. The
Rust side looks for `rnnoise.rnnn` in the app data `models` folder and uses `arnndn` when it is there,
so dropping the file in is the whole switch.

Tauri: `audio_clean_mic(projectDir)` (async) makes the copy when it is stale and returns its path;
the editor calls it when a project opens (when noise removal is on) and before export. The preview
plays the cleaned copy once it exists and the switch is on; until then it plays `mic.wav`. In a plain
browser there is no cleaning: the preview plays `mic.wav` (the editor still runs).

## Even loudness

Two steps at export, both in Rust:
1. Measure: FFmpeg runs the export's audio graph (cuts, volumes, fades, mix) into `ebur128` and reads
   integrated loudness, loudness range, threshold and true peak (8 minutes in about 1 s).
2. Mux: the same graph ends in `loudnorm=I=-14:TP=-1.5:LRA=11` with the measured values
   (`linear=true`). When a linear gain would push peaks over -1.5 dB, `loudnorm` switches to its
   dynamic mode by itself; speech then lands near -14.9 LUFS (measured), inside YouTube's tolerance.
   `aresample=48000` follows (loudnorm works at 192 kHz).
A silent mix (measured below -70 LUFS) is left alone.

## Preview

Per track gain each frame = volume x fade envelope at the current output time, set on the audio
element (`volume`, capped 0 to 1); mute uses `muted`. Pure function in `@marz/timeline`
(`trackGain`), tested.

## Export job (Rust `ExportJob`, all new fields optional)

- `MicJob` gains `fadeInUs`, `fadeOutUs` (default 0) and `clean` (mic only: read
  `cache/mic.clean.wav` instead of `file`; the path is fixed in Rust, never sent by the page).
- `ExportJob` gains `normalize: { targetLufs }` (absent: no loudness step). The measure runs inside
  the export start, before the muxer.

## UI (DESIGN-SYSTEM.md "Inspector", Audio block)

Project panel, after Camera, before AI edit, after a 1px ink rule: section label "Audio". Per track
(Mic, then Computer sound when recorded): a volume row (48px, the Pace slider style, label left,
value right "80%"), a "Mute" toggle row (34px), a "Fade in and out" row with the segmented control
(Off, 0.5, 1, 2 s). Then two toggles: "Remove mic noise" and "Even loudness at export", and one
10px faint line with the cleaning state ("Cleaning mic sound", "Mic cleaned. Preview plays it",
"Plays the original mic in the browser"). Every change is one undo step.

## Checked (2026-11-19)

- Tests: format defaults and round trip, commands and undo, preview gain, export graph strings, loudness
  parser, cleaning stamp; real FFmpeg runs: a noisy synthetic take cleaned (noise down, tone held, same
  length, `mic.wav` byte-identical), a normalized export lands within 1.5 LU of -14 and fades in.
- Browser (Edge, 1440 x 900): Audio block on a sample copy with computer sound; fade 1 s sets the mic element
  to 0 at the start, mute mutes, edits saved to `project.json`.
- Tauri app on "Audio test" (copy of his 8 min take, 38 cuts, 5:43 exported): cleaned copy made on open
  (the preview plays it), exports of both presets: integrated -14.8 LUFS, true peak -1.2 dBFS (AAC adds about
  0.3 dB over the -1.5 ceiling; YouTube asks for -1), audio and video lengths equal (343.12 s). His mic before
  cleaning: -21.8 LUFS, noise floor -82.4 dBFS (10th percentile of 0.25 s windows over the whole take); after:
  noise floor -86.5, speech level unchanged (-18.8 to -18.9 at the 90th percentile).
- Tauri app on "Audio test system" (copy of the 19.18 take with computer sound, 2 s fades on it): computer sound
  in the export (-12.5 dB where it plays), mix -14.3 LUFS. That take's computer sound is silent at both ends, so
  the fades are shown by the FFmpeg test, not by this file.
- Not done: listening (nothing was played out loud overnight).
