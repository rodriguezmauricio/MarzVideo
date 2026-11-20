# Background image, blur and gradient: plan

Design: `docs/superpowers/specs/2026-11-19-background-image-blur-design.md`.

1. Format: `BACKGROUND_STYLES` gains gradient, image, blur; `BackgroundEdits` gains `gradient` and `image`
   (safe path check). Tests in `packages/format`.
2. Timeline: `setBackground` handles `image: null` (removes the field). Test.
3. Compositor: `BackgroundDraw` carries `gradient`; `paintBackdrop` draws gradient, cover image (cached) and
   blur (small canvas); `drawFrame` gets `backdropImage`. Tests with a fake context.
4. Storage: `pickBackgroundImage()` on http storage (file input + PUT) and Tauri storage (Rust command).
   Vite plugin accepts the asset PUT; image MIME types. Rust command with tests (path, signature, size, hash name).
5. App: `useBackgroundImage` loader (cached ImageBitmap by URL) for the preview; the export loads it once.
   Preview, export and `drawVertical` pass it. Inspector BackgroundBlock: style grid, Colours row, Image row.
6. Docs: milestone-1 format section, DESIGN-SYSTEM if a new pattern, CLAUDE.md status, DEVIATIONS if any.
7. Checks: typecheck, test, design:check, cargo test; browser 1440 x 900 and 1280 x 720; blur cost per frame;
   app exports YouTube and vertical for each new style, ffprobe and a frame grab each.

## Results

2026-11-20, this laptop, Edge (Playwright, `msedge` channel) against the dev server and the demo sample.

- `pnpm typecheck`, `pnpm test`, `pnpm design:check`, `cargo test --workspace`: pass.
- Inspector and preview at 1440 x 900 and 1280 x 720: the eight-style grid, the Colours row, Pick image (file chooser, PUT to
  `assets/`), the image row with the file name, Gradient, Image and Blur drawn in the preview (canvas pixels read: gradient ink at top
  left, accent at bottom right; image colours at the corners; blur picture at the corners), vertical preview with Blur.
- Blur cost, `paintBackdrop` alone from the playing video element, 300 frames: 0.6 ms per frame at 1920 x 1080, 0.2 ms at 1080 x 1920,
  0.3 ms at 2560 x 1440 (ink 0.01 ms, gradient 0.01 ms).
- Exports through `exportProject` with the memory sink (`?export=memory`), muxed with FFmpeg, ffprobe and a frame grab at 12 s each:
  Gradient, Image and Blur on YouTube (1920 x 1080) and vertical Follow (1080 x 1920), plus Blur on vertical Fit. All h264, 30 fps,
  900 frames, 30.0 s; every grab shows the backdrop around the framed screen. Time for the 30 s demo: off 7.0 s (YouTube) and 6.9 s
  (vertical), ink 6.7 s, gradient 6.6 and 7.7 s, image 8.6 and 6.9 s, blur 8.1 to 9.5 s (YouTube) and 8.4 to 10.2 s (vertical). Blur makes
  an export about 15 to 35% slower; the others are within noise.
- Not checked: the Tauri app (the Pick image dialog and copy in Rust run only in unit tests; no app export with a background image).
