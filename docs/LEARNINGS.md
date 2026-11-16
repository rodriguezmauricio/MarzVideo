# Learnings

- [2026-11-15] [claude] Pointer handlers must read the latest drag draft from a ref, not React state: pointerup can arrive before React re-renders after the last pointermove, which committed an empty or stale edit.
- [2026-11-15] [claude] Never define a component inside another component's render (the old timeline resize Handle): it remounts on every render and drops pointer capture mid-drag. Use a render helper function.
- [2026-11-15] [claude] Playwright's own Chromium cannot play H.264 MP4. Browser checks of the editor must use `channel: "msedge"` (or Chrome).
- [2026-11-15] [claude] Vitest does not type-check. Run `pnpm typecheck` as well as `pnpm test`; it caught a narrowing error the tests missed.
- [2026-11-15] [claude] Source frames that are not 16:9 (16:10 laptops, region captures) are letterboxed by `frameAt().dstRect`; zoom rects stay aspect-locked so zooming fills the output.

- [2026-11-16] [claude] This checkout's node_modules were symlinks into a deleted folder (Desktop/MarzVideo), so tsc and vitest were missing. Fix: `CI=true pnpm install --prefer-offline --frozen-lockfile` (no TTY, so pnpm needs CI=true to purge).
- [2026-11-16] [claude] The `.dc.html` mockups render in Edge without support.js: replace `{{accent}}` with the hex and screenshot `.win`. Their computed styles are the reference (e.g. `.win button { padding: 0 }` beats `.lr2` padding).
- [2026-11-16] [claude] design-check flags `el.blur()` and words like "rounded" in comments. Use a `design-check-ignore` comment with a reason rather than renaming the DOM call.
- [2026-11-16] [claude] Fonts are bundled locally (src/assets/fonts, src/styles/fonts.css), the desktop app must work offline. Both are variable fonts, so one woff2 per subset covers all weights: declare weight ranges ("500 700"), not one face per weight.

## Deferred from the M1 editor review (minor, not fixed)

- Mic offset above 40 ms: audio starts at once then jumps back, so the first stretch is heard twice (`Preview.tsx`).
- Inspector blur always commits and rounds to 10 ms; `updateZoom` with identical values still adds an undo step.
- Auto zoom: end not clamped to the duration; a run with no clicks adds an undo step; re-running discards tweaked auto zooms (bare key A makes that easy); a widely spread cluster gives a near full-frame zoom; no overlap check against manual or live zooms.
- Holding Z or C (key repeat) stacks duplicate blocks.
- A missing or unplayable `screen.mp4` leaves a black preview with no message.
- `parseProject` accepts `durationUs: 0` and zero sizes; an unknown `easing` or `origin` value rejects the whole project.
- Dev server middleware has no try/catch; the `project.json` write is not atomic (the Tauri storage should write a temp file and rename).
- Header clock shows source length, not export length. The spec line "the timeline maps to output time" now differs from the code (playhead is in source time).
- Sample uses `testsrc` (built-in timestamp) instead of `testsrc2`; there is no `usePlayback.ts` (logic lives in `Preview.tsx`).
- No committed Playwright tests: the browser checks were run by hand.
- Pin down for the recorder: how `durationUs` relates to the track lengths, and which mouse `button` values it writes.
- `drawFrame` should scale by the media's real pixel size, not `project.source`, before proxies arrive.
