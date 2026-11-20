# Background image, blur and gradient: design

Date: 2026-11-19. Product spec section 11 ("wallpaper, gradient or blur"). Extends
`2026-11-19-background-frame-design.md`. Owner pre-approved building straight through; merging is not approved.

## What the owner sees

The Background block's style picker grows from five to eight choices, shown as the camera shape grid
(three columns, words only):

| Name     | What it is |
|----------|-----------|
| Off, Ink, Paper, Glow, Grid | As before. |
| Gradient | A straight two-colour gradient from the top left corner to the bottom right. |
| Image    | His own JPG or PNG, scaled to cover the whole video (cropped, never stretched). |
| Blur     | The screen itself, scaled to cover the whole video, blurred and darkened, behind the framed screen. |

Under the picker, for the new styles only:

- **Gradient**: a "Colours" row with three pairs, all brand tokens: Ink to accent (default), Ink to paper,
  Paper to accent. No other colours, no hex outside `tokens.css`.
- **Image**: an "Image" row with the file name (or "None") and a "Pick image" link. Picking copies the file into
  the project folder as `assets/background-<hash>.<ext>`; the original file is never touched, and the raw tracks
  are never touched. Picking the same file twice reuses the copy. While no image is set, or the file is missing,
  the video shows ink behind the frame and the row says "Image missing" in the error style.
- **Blur**: no options.

Margin, corners and shadow work for every style as before.

## Format (`project.json`, version stays 1)

`edits.background` (optional) gains two optional fields; `style` gains three values:

```
{ "style": "off" | "ink" | "paper" | "glow" | "grid" | "gradient" | "image" | "blur",
  "padding": "S" | "M" | "L", "corners": "square" | "round", "shadow": bool,
  "gradient": "ink-accent" | "ink-paper" | "paper-accent",
  "image": "assets/background-1a2b3c4d.jpg" }
```

- `gradient` missing or unknown reads as `ink-accent`.
- `image` is a path inside the project folder. Only `assets/<name>.jpg|jpeg|png` is accepted (no `..`, no
  absolute path); anything else reads as no image. The style stays `image` when the image is cleared, so the
  owner sees "Image missing" instead of the background silently changing.
- An older build reading a new style falls back to off (its reader's default), so older builds show the plain
  screen. The raw object is kept on save, so the fields survive a round trip.
- It stays a plain JSON object (scene presets copy it as is). A preset that carries `image` only works in a
  project that has that asset; elsewhere it reads as "Image missing".
- `assets/` is a new optional folder in the `.marz` folder. Only the app writes it. Archive copies it like
  every other file; "Remove raw files" never touches it.

## Drawing (`packages/compositor/src/background.ts`)

`paintBackdrop(ctx, look, out, colors, sources)` now takes the backdrop look (`style`, `gradient`) and the
sources `{ screen, image }`; `drawFrame` gains an optional last argument `backdropImage`.

- **Gradient**: `createLinearGradient(0, 0, w, h)` with the two token colours. Full strength.
- **Image**: the image cover-fitted (centred crop) over the whole output. The scaled copy is cached per image
  and output size (one drawImage of a cached canvas per frame), so a large photo costs nothing per frame after
  the first.
- **Blur**: the current screen frame (the same `source` drawFrame already gets: video element in the preview,
  decoded frame in the export, a proxy when raw files are archived) cover-fitted into a small canvas at 1/12 of
  the output size with an extra bleed, blurred there with `filter: blur(2px)` (about 24 px at full size), then
  scaled up to the whole output with smoothing and darkened with ink at 35%. Cheap because the blur runs on a
  canvas of about 160 x 90. It follows the full screen (not the zoom, not the vertical window), so zooms and the
  vertical aim do not make the backdrop jump. Where `filter` is not supported the small canvas is still drawn
  (a soft scaled picture).
- Smart vertical Follow: the backdrop covers the 9:16 picture (blur and image cover-fit to 1080 x 1920). Fit:
  the 16:9 picture with its background, letterboxed on ink bars, as before.
- The zoom editor still hides the background while a zoom is edited.

## Speed

The blur costs about 0.6 ms per frame at 1920 x 1080 (0.2 ms vertical) on this laptop; a whole export with Blur is about 15 to 35%
slower than without a background (numbers in the plan). Gradient and Image cost nothing measurable.

## Picking the image

- App: a Rust command `pick_background_image(dir)` opens the file dialog (JPG, PNG), checks the file (at most
  40 MB, JPEG or PNG signature), copies it to `<dir>/assets/background-<first 8 hex of SHA-256>.<ext>` and
  returns the relative path. The page never hands over a source path; `dir` must be a folder Home allowed.
- Browser (sample, dev only): a hidden file input; the page PUTs the bytes to the Vite projects plugin, which
  accepts writes to `assets/background-<hex>.(jpg|jpeg|png)` besides `project.json`.
- Both go through `ProjectStorage.pickBackgroundImage()`. The image loads with `storage.fileUrl(path)`.

## Out of scope

Per-section backgrounds, a blur strength setting, image position or zoom, video wallpapers, removing unused
asset files.
