# Export extras: design (2026-11-19)

Product spec section 12, the rest of it: codec, resolution and frame-rate choices, and an export target
for MarzOS. Built on the M1 export (WebCodecs encodes in the webview, FFmpeg muxes). Pre-approved by the
owner to build straight through.

## What changes for him

The Export MP4 panel keeps its two preset rows. Under them, rows for the highlighted preset:

| Row | YouTube | Instagram and TikTok |
|---|---|---|
| Codec | H.264 (default), HEVC | H.264 (default), HEVC |
| Size | 720p, 1080p (default), 1440p | not shown (stays 1080 x 1920) |
| Frame rate | 24, 30, 60; default the source rate (60 max) | 24, 30, 60; default 30 |
| Follow the action | not shown | as before |
| Burn captions | as before | as before |
| Also copy to | folder name, or Off | same (one folder for both) |

- The size on each preset row shows what the export will use ("2560 x 1440, 60 fps, HEVC" for a changed row;
  "1920 x 1080, 60 fps" with the defaults, as before).
- A frame rate above the source rate is shown faint and cannot be picked ("The recording is 30 fps").
- HEVC: when the panel opens the editor asks WebCodecs whether this computer can encode HEVC. If not, the
  HEVC button is faint and the codec row's last line says "HEVC is not available on this computer. Exports
  use H.264." If an export with HEVC picked still fails to set up the encoder, it uses H.264 and the done line
  says "Exported as H.264. HEVC is not available."
- Measured limit (this laptop, WebView2 157, NVIDIA): HEVC needs Chromium's `PlatformHEVCEncoderSupport`
  feature (off by default), which the app switches on for every window at start (`src-tauri/src/webview.rs`).
  Even then the platform encoder only takes up to 1920 x 1080 pixels (1080 x 1920 too) at 30 fps or less. The
  panel asks WebCodecs at the export's own size and rate; when HEVC cannot be used there it says "HEVC is not
  available at this size and frame rate. This export uses H.264." and the row's size drops ", HEVC".
- Choices are remembered per preset in the webview's local storage (the "Burn captions" pattern). They are
  NOT in `project.json`: the preset never was, so its sub-choices are not either. `project.output` is
  unchanged.

## Encoding

- Codec strings: H.264 High `avc1.640028` (level 4.0, as today) up to 1080 lines, `avc1.640033` (5.1) above.
  HEVC Main `hvc1.1.6.L123.B0` (4.1) up to 1080 lines, `hvc1.1.6.L153.B0` (5.1) above. Both annexb.
- Hardware first, as today: `prefer-hardware`, then `no-preference`.
- Bitrates (VBR, bit/s), H.264: 720p 5 M / 7.5 M (above 30 fps), 1080p 8 M / 12 M (unchanged),
  1440p 16 M / 24 M (YouTube's own upload guidance). Vertical 6 M at 30 fps or less (unchanged), 9 M above.
  HEVC: 60 percent of the H.264 number.
- Size: the landscape picture is composited straight at the chosen size (`frameAt`, `layoutAt` and
  `drawFrame` already take the output size), so 1440p is drawn at 1440p, not a 1080p picture scaled up. The
  vertical preset is unchanged.
- Frame rate: the choice, capped at the source rate (rounded) and at 60. `outputFrameTimes` already samples
  any rate (24 fps from a 60 fps take picks the nearest earlier source frame).

## Muxer (Rust)

`ExportJob` gains `codec` ("h264" default, "hevc"; serde default so older pages still work). FFmpeg reads
`-f hevc` for HEVC and writes `-tag:v hvc1` so Windows and Apple players accept the MP4. Video is still
copied, never re-encoded.

## Also copy to (MarzOS export target)

- A row at the end of the panel: `folder` icon, "Also copy to", and on the right the folder's name (faint) or
  "Off". A click opens the native folder dialog ("Pick the folder to copy exports to"); when a folder is set,
  a `close` button at the row's right end turns it off. Remembered in the app config folder
  (`export-settings.json`, `{"copyTo": "..."}`), like the archive folder. Shown only in the app.
- After a good export (MP4 written, `.srt`/`.vtt` written), Rust copies into that folder: the MP4, the
  `.srt` and `.vtt` when they exist, each through a `.part` file and a rename, then writes the sidecar
  `<name>.json` last, so a watcher that waits for the JSON sees complete files.
- Sidecar:
  ```json
  { "title": "Demo", "lengthSec": 62.4, "preset": "youtube", "codec": "h264", "width": 1920, "height": 1080,
    "fps": 60, "video": "Demo YouTube.mp4", "captions": { "srt": "Demo YouTube.srt", "vtt": "Demo YouTube.vtt" },
    "exportedAt": "2026-11-19T18:02:11Z", "app": "Marz Recorder" }
  ```
  `captions` is null without a transcript. Paths are file names in the same folder.
- Rust takes the destination from its own settings, never from the page, and only copies MP4s this app just
  exported (the `done` set). A folder inside a project is refused. No network calls.
- Done line: "Exported. Show in folder" then, faint, "Copied to <folder name>." or "Could not copy to
  <folder name>." (reason to the console). The export itself counts as good either way.

## Home lede

"Screen, camera, mic, computer sound and clicks are kept as separate tracks. Zooms, cuts, layouts, captions
and drawings sit on top as edits. Nothing is baked in, so fix and polish afterwards."

## Out of scope

Automated publishing, network hooks, per-project export settings, other containers, 4K.
