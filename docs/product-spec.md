# Marz Recorder — Product Spec

A Windows-first screen recorder and editor under the Marz brand. Built for Mauricio's daily use, structured so it can go public later.

## 1. Product goals

* Record screen, camera, mic and system audio as separate files, never burned together.
* Edit everything non-destructively: zooms, drawings, camera layouts and captions are data layers on top of raw tracks.
* Live control while recording (zoom presets, drawing, layout switches) with full editability afterwards.
* Top UX priority: very intuitive. Every action must be obvious. Professional output, no clutter.
* Standalone product, not part of MarzOS. AI features go through a swappable provider interface.

## 2. Platform and stack

* Tauri 2 desktop app (Rust core + web UI). Windows 11 first. Mobile is out of scope.
* UI: React + TypeScript, Vite, Zustand for state, Tailwind for styling.
* Capture: Windows Graphics Capture (WGC) API for full screen, window and region; borderless capture where supported.
* Camera: Media Foundation capture, saved as its own file.
* Audio: WASAPI (Windows Audio Session API) — mic and system loopback as separate tracks.
* Encoding: hardware encoders via FFmpeg (NVENC / QuickSync / AMF) with software fallback. Recording to fragmented MP4 so crashes don't corrupt files.
* Preview and render: WebGPU compositor in the editor; same scene graph used for export via FFmpeg pipeline.
* Transcription: local Whisper (whisper.cpp), word-level timestamps.
* AI: provider interface; default Claude API, swappable to local model or MarzOS route.

## 3. Architecture

Recorder → Raw tracks + Event log → Project file → Editor (scene graph) → Export

* Capture engine (Rust): owns devices, encoders, file writing, global hotkeys, input hooks.
* Event log: timestamped JSON stream of clicks, keypresses (optional), cursor positions, zoom triggers, layout switches, drawing strokes, checklist ticks.
* Project format: a folder `project.marz/` containing `screen.mp4`, `camera.mp4`, `mic.wav`, `system.wav`, `events.jsonl`, `project.json` (edits), `transcript.json`, and `proxies/`.
* Editor: reads raw tracks plus project.json; never modifies raw files.
* Modules are isolated packages: capture, events, compositor, timeline, audio, captions, ai, storage, export. Each has a typed interface so features can be swapped or extended.

## 4. Recording

Capture modes

* Full screen (pick monitor), single window, drag-select region, typed exact dimensions.
* Region drawn with on-screen overlay; aspect lock option (16:9 default).

Tracks recorded separately

* Screen video, camera video, mic audio, system audio, event log.
* All tracks share one monotonic clock for perfect sync.

Live controls (hotkeys + floating mini toolbar)

* Start / pause / stop, mute mic, toggle camera.
* Trigger zoom presets.
* Switch camera layout scenes.
* Draw / erase on screen.
* Hide cursor toggle.
* Toolbar and checklist overlay are excluded from capture.

## 5. Zoom

* Zoom presets: before or during recording, drag rectangles over screen areas. Rectangles are locked to the output aspect ratio. Each preset gets a hotkey and a small optional on-screen icon.
* Triggering a preset logs a zoom event; editor shows it as an editable zoom block (in/out time, easing, target rect).
* Auto zoom: editor generates suggested zooms from click and cursor clusters in the event log. User accepts, tweaks or deletes.

## 6. On-screen drawing

* Draw live with pen, highlighter, arrow, rectangle, ellipse, text. Erase live.
* Every stroke saved as a vector object with appear and disappear timestamps.
* In the editor each stroke can be moved, resized, recolored, retimed or deleted.

## 7. Camera and layouts

* Masks: any vector shape — circle, rounded rect, star, custom drawn path, imported SVG.
* Layout scenes: presets combining camera shape, size, position, border, shadow, plus the screen's frame. Examples: corner bubble; side column (full-height 9:16 panel with screen reflowing into remaining space); floating 9:16; camera fullscreen; screen only.
* Live switching via hotkeys, previewed in real time; logged as events, fully retimable later.
* Motion paths: draw a curve the camera travels along between scenes, with easing. Shape morph (e.g. circle → 9:16) can start at path end or blend along it. Paths can be saved inside transition presets so live triggers follow the exact route.
* Screen layer animates its size and position in sync with the camera.

## 8. Cursor and clicks

* Cursor kept exactly as recorded — no smoothing.
* Cursor is captured as a separate layer (position data + sprite), so it can be hidden for the whole video or per section.
* Click effects (ripple, pulse, ring) generated from the event log; style, color and size adjustable; toggle per section.

## 9. Audio

* Mic and system audio on separate tracks with independent volume, mute and fades.
* Noise cancelling is required (RNNoise or DeepFilterNet, local).
* Optional: silence detection and cut, loudness normalization, filler-word removal from transcript.

## 10. Captions and AI checklist

* Local Whisper transcription with word-level timing.
* Editable captions: fix a word by editing text; style presets; word-by-word highlight for Reels.
* AI checklist overlay: before recording, list topics to cover. During recording, live transcript is compared against the list by the AI provider and items tick off automatically. Overlay is visible only to the user, never captured.
* Only text is sent to the AI, never video.

## 11. Editor and timeline

* Hybrid timeline: default view is one main track with zooms, layout switches, drawings and cuts as colored blocks you drag, trim or delete. One click expands into separate lanes: screen, camera, mic, system audio, zoom, layout, drawing, captions.
* Live preview canvas with direct manipulation: drag camera, resize zoom rects, move strokes on the canvas itself.
* Background and frame: padding, rounded corners, shadow, wallpaper, gradient or blur. Saved inside scene presets.
* Undo/redo for every action; autosave every few seconds.

## 12. Output

* Landscape master (16:9). Export MP4 (H.264 / HEVC), resolution and frame-rate presets.
* Auto-reframe to 9:16 using cursor, click and zoom data to aim the crop; camera moves into its own top or bottom slot instead of being cropped.
* Export target for MarzOS via a hook (folder drop or API). Automated publishing is a future module.

## 13. Storage

* Projects saved locally. Crash-safe recording plus recovery on next launch.
* Manual archive to Google Drive, triggered by the user only.
* Option to remove heavy raw files locally after archive, keeping lightweight proxies for editing.

## 14. Design direction

* Clean, dark-first UI with a light theme option. One accent color from the Marz brand.
* Three screens: Home (projects + new recording), Recorder (floating mini toolbar + overlays), Editor (canvas center, timeline bottom, inspector right).
* Inspector is contextual: shows only settings for the selected item.
* Every tool has a visible icon, label on hover, and hotkey shown in the tooltip.
* Visual mockups to be produced before the build (separate design pass).

## 15. Build order

1. Capture engine + separate track recording + event log.
2. Project format + editor shell + playback sync.
3. Zoom presets and auto zoom.
4. Camera masks, layout scenes, motion paths.
5. Live drawing as vectors.
6. Audio cleanup, transcription, captions, AI checklist.
7. Export, auto-reframe, archive.
8. Polish, onboarding, settings.

> Note: the build order above is the original. The agreed order for milestone 1 is in
> `docs/superpowers/specs/2026-11-15-milestone-1-design.md`.
