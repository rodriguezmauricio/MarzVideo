# Marz Recorder — Milestone 1 Design

**Status:** APPROVED by Mauricio on 2026-11-15, as written. Build order steps 1 to 6 are built (2026-11-17); the owner checks in `docs/spikes/2026-11-17-owner-checks.md` are still open. Home and the recorder screens are part of M1 (approved 2026-11-17).
**Date:** 2026-11-15
**Full product spec:** `docs/product-spec.md`

## Intent

Mauricio's current screen recorders are inflexible and slow to work with. Milestone 1 (M1) is the
smallest version of Marz Recorder that replaces them for daily use:

> Record screen + mic + input events → edit zooms and cuts → export MP4.

Everything else in the product spec (camera layouts, drawing, captions, AI checklist, auto-reframe,
archive) comes after M1 is in daily use.

## Goals

- Record screen video, mic audio and an event log as **separate files** on one shared clock.
- Open the recording in an editor with synced playback, a timeline, and editable zoom blocks.
- Auto-suggest zooms from click clusters; user accepts, tweaks or deletes.
- Cut sections out. Export an MP4 (H.264): a 16:9 YouTube preset (1920 x 1080 at the source frame rate, 60 max) and a vertical preset (1080 x 1920 at 30 fps, the 16:9 frame letterboxed). The preset is an export choice; `project.output` does not change.
- Undo/redo and autosave.

## Non-goals for M1

Camera, system audio, live drawing, layout scenes, motion paths, captions, transcription, AI
checklist, noise cancelling, 9:16 reframe, Google Drive archive, light theme, onboarding.
The project format must leave room for all of them (see "Format contract").

## Anti-goals

- Raw tracks are never modified or re-encoded in place. Edits live only in `project.json`.
- Preview and export must not look different from each other.
- No cursor smoothing, ever.

## Constraints

- Windows 11 only. WGC / WASAPI code compiles and runs only on Windows.
- Development happens in two places: cloud sessions (Linux, from the phone) and the local Windows
  machine. Cloud sessions cannot run capture code, so they must only produce work that can be
  tested there (editor, format, timeline, compositor logic).

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Follow the spec order: capture engine first | Hardest part first, but capture code written in the cloud is untested until run on Windows; the editor waits behind it. |
| **B** | **Contract first, split by where it can be tested** | Format is locked first; editor is built against a sample project anywhere; capture is built on Windows. Both halves only meet at the format. **Chosen.** |
| C | Thin end-to-end slice only on Windows | Fastest to daily use, but cloud sessions contribute almost nothing. |

**Chosen: B, with C's scope discipline** (M1 scope above). Picked by Mauricio on 2026-11-15.

## How the work is split

| Where | What | How it is tested |
|---|---|---|
| Anywhere (cloud or local) | `packages/format` — types + validators for `project.marz` | Unit tests |
| Anywhere | Sample project generator (synthetic `screen.mp4`, `mic.wav`, `events.jsonl`) | Output validates against the format |
| Anywhere | Editor: shell, playback sync, timeline, zoom blocks, auto zoom, cuts, undo/redo | Runs in a plain browser against the sample project (no Tauri call on the browser path); unit + Playwright tests |
| Windows only | Capture engine (Rust): WGC screen, WASAPI mic, input hooks, hotkeys, file writing | Record a real clip; output must validate against the format |
| Windows only | Tauri shell, recorder toolbar, export encode | Manual run on Windows |

Rule: the editor must run in a normal browser with file access behind a small `storage` interface
(Tauri implementation + browser/dev implementation). That is what keeps cloud sessions useful.

## Format contract (`project.marz/` v1)

A folder. The recorder writes the raw files once; the editor only ever writes `project.json`.

```
MyRecording.marz/
  project.json     edits + metadata (editor-owned after creation)
  events.jsonl     input events (recorder-owned, append-only)
  screen.mp4       fragmented MP4, H.264, constant frame rate
  mic.wav          48 kHz PCM
  proxies/         optional, later
  (later: camera.mp4, system.wav, transcript.json)
```

**Time:** every timestamp is an integer number of **microseconds since recording start** (`tUs`),
taken from one monotonic clock (QueryPerformanceCounter). Each track records its own `offsetUs`
(when its first sample landed on that clock) so tracks can be aligned exactly.

**Coordinates:** in events, pixels in the captured source frame (origin top-left). In edits,
normalized 0–1 relative to the source frame, so edits survive resolution/proxy changes.

### `events.jsonl` — one JSON object per line

```jsonl
{"type":"header","version":1,"source":{"width":2560,"height":1440,"fps":60},"startedAt":"2026-11-15T19:00:00Z"}
{"tUs":16000,"type":"cursor","x":1203,"y":644}
{"tUs":812000,"type":"click","button":"left","state":"down","x":1203,"y":644}
{"tUs":903000,"type":"click","button":"left","state":"up","x":1203,"y":644}
{"tUs":4100000,"type":"zoom","presetId":"p1","action":"in"}
{"tUs":9000000,"type":"pause"}
{"tUs":9000000,"type":"resume"}
```

- `cursor` is sampled at most once per captured frame, only when the position changes.
- The cursor is **not** drawn into `screen.mp4`; it is rendered from this log (sprite capture is
  post-M1; M1 uses a standard arrow sprite).
- Readers must ignore unknown `type` values. That is how later features (layout, stroke, key,
  checklist) get added without a version bump.
- A crash can leave a half-written last line; readers must drop an unparseable final line.

### `project.json`

```json
{
  "version": 1,
  "id": "uuid",
  "name": "My Recording",
  "createdAt": "2026-11-15T19:00:00Z",
  "durationUs": 63500000,
  "source": { "width": 2560, "height": 1440, "fps": 60 },
  "tracks": {
    "screen": { "file": "screen.mp4", "offsetUs": 0 },
    "mic":    { "file": "mic.wav", "offsetUs": 12400, "volume": 1, "muted": false }
  },
  "output": { "width": 1920, "height": 1080, "fps": 60 },
  "zoomPresets": [
    { "id": "p1", "name": "Editor", "rect": { "x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5 } }
  ],
  "edits": {
    "zooms": [
      { "id": "z1", "startUs": 4100000, "endUs": 8200000,
        "rect": { "x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5 },
        "easeInUs": 400000, "easeOutUs": 400000, "easing": "easeInOutCubic",
        "origin": "live" }
    ],
    "cuts": [ { "id": "c1", "startUs": 20000000, "endUs": 23500000 } ],
    "cursor": { "hidden": false },
    "clicks": { "effect": "none" }
  }
}
```

- `origin` on a zoom is `"live"` (triggered while recording), `"auto"` (suggested) or `"manual"`.
- Zoom rects keep the output aspect ratio. Cuts are in source time; the timeline maps to output time.
- Unknown fields must be preserved on save, so an older build never destroys newer data.

## Technical calls (Claude's, open to correction)

1. **One renderer for preview and export.** The compositor draws a frame for any time `t`. Preview
   plays it live; export steps it frame by frame. The webview encodes the frames (WebCodecs
   `VideoEncoder`, hardware first, falling back to no preference); FFmpeg only muxes the audio and
   writes the MP4. (Changed 2026-11-17, approved by Mauricio: the first plan piped raw pixels to
   FFmpeg for encoding.) The product spec's "FFmpeg pipeline" for compositing is dropped because two
   renderers would drift.
2. **Compositor starts on Canvas 2D / WebGL2 behind an interface, WebGPU later.** M1 only needs
   crop + scale + cursor; a simpler backend is testable everywhere. The interface keeps the WebGPU
   swap cheap when layouts and masks arrive.
3. **Screen capture via the `windows-capture` crate** (wraps WGC) instead of raw bindings.
   To verify on Windows first: frame timestamps, cursor exclusion, and excluding our own windows
   from capture (`SetWindowDisplayAffinity` / `WDA_EXCLUDEFROMCAPTURE`).
4. **Mic via the `wasapi` crate**, written straight to WAV.
5. **Recording encode via an FFmpeg sidecar process**, fragmented MP4 without B-frames, hardware
   encoder probed at startup with `libx264` fallback. Minimum FFmpeg 5.1.
6. **Monorepo with pnpm workspaces:** `apps/desktop` (Tauri + React), `packages/*` (format,
   timeline, compositor, …), `crates/capture` (Rust).

Calls 3–5 were unverified until tried on the Windows machine; the first local session spiked them
before anything was built on top.

**Spiked 2026-11-16: calls 3 to 5 hold** on Windows (60 fps CFR at 1080p, mic drift about 1 ms over
3 min, own window and cursor excluded). Two required changes and the numbers: `docs/spikes/2026-11-16-capture-spike.md`.

## M1 build order

1. `packages/format` + sample project generator.
2. Editor shell: load project, synced playback, timeline with zoom + cut blocks, inspector.
3. Zoom editing on canvas + auto zoom from clicks. Undo/redo, autosave.
4. (Windows) Capture spike → capture engine writing valid `project.marz`.
5. (Windows) Tauri shell: Home, recorder mini toolbar, hotkeys, zoom presets.
6. (Windows) Export.

Steps 1–3 and 4 can run in parallel.

## Left to the builder

Component structure, state shape, test layout, exact easing curves, timeline visuals (pending the
separate visual design pass in the product spec, section 14).
