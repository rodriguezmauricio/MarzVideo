# Audio cleanup: plan (2026-11-19)

Design: `docs/superpowers/specs/2026-11-19-audio-cleanup-design.md`. TDD for format, gain and
filter-graph logic.

1. **Format** (`packages/format`): `edits.audio` schema (optional, passthrough), `audioEdits(p)`
   with defaults. Tests: defaults, round trip keeps unknown keys, older projects parse.
2. **Commands and gain** (`packages/timeline`): `setTrackVolume`, `setTrackMuted`, `setTrackFade`,
   `setAudioOption` (one undo step each); `trackGain(volume, muted, fade, tOutUs, durOutUs)`. Tests.
3. **Export graph** (`crates/export`): fades per track (`afade`), clean mic input, loudness tail
   (`loudnorm` with measured values), measure args (`ebur128`) and parser, clean args and stamp.
   Tests on the strings and the parser; one ignored-free test runs real FFmpeg on a synthetic file
   when FFmpeg is on PATH.
4. **Tauri**: `audio_clean_mic` command (async), measure inside export start.
5. **Editor**: export job fields (`sink.ts`), clean before export, preview gain per frame and cleaned
   mic source, Audio block in the inspector, lane label shows "Muted".
6. **Checks**: `pnpm test`, `pnpm typecheck`, `pnpm design:check`, `cargo test --workspace`; browser
   at 1440 x 900; Tauri app exports of both presets on the copy "Audio test", measured with
   `ebur128` and `astats`.
7. **Docs**: format contract in the M1 design doc, DESIGN-SYSTEM.md Audio block, DEVIATIONS,
   LEARNINGS, CLAUDE.md status line.
