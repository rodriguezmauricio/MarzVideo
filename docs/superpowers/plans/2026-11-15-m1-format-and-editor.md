# M1 Format and Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `project.marz` format package, a sample project generator, and a browser-runnable editor (synced playback, timeline with zoom and cut blocks, auto zoom, undo/redo, autosave).

**Architecture:** pnpm monorepo. Pure logic lives in small TypeScript packages (`format`, `timeline`, `compositor`) that are unit-tested in Node. The editor app (`apps/desktop`, React) reads a project through a `ProjectStorage` interface; this plan ships the browser/dev implementation. One compositor function (`frameAt` + `drawFrame`) draws any frame for time `t`, so a later export step reuses it and preview cannot drift from export.

**Tech Stack:** pnpm workspaces, TypeScript, Vitest, zod, Vite, React, Zustand, Tailwind, FFmpeg (sample generation only).

**Spec:** `docs/superpowers/specs/2026-11-15-milestone-1-design.md` (design steps 1 to 3). Full vision: `docs/product-spec.md`.

**Out of this plan:** capture spike and engine (Windows), Tauri shell, recorder toolbar, export. Each gets its own plan after this one. Nothing here may import Windows-only code.

## Global Constraints

- Time unit: integer microseconds since recording start, named `...Us`, from one clock.
- Edit coordinates: normalized 0 to 1 relative to the source frame. Event coordinates: source pixels, origin top-left.
- Raw tracks (`screen.mp4`, `mic.wav`, `events.jsonl`) are never written by the editor. The editor writes only `project.json`.
- Unknown fields in `project.json` are preserved on save. Unknown event `type` values are ignored. A half-written last line of `events.jsonl` is dropped.
- Zoom rects keep the output aspect ratio. Cuts are in source time.
- No cursor smoothing. The cursor is the latest recorded sample at or before `t`.
- Zoom `origin` is one of `"live" | "auto" | "manual"`. Easing is `"linear" | "easeInOutCubic"`.
- `screen.mp4` is fragmented MP4, H.264, constant frame rate. `mic.wav` is 48 kHz PCM.
- The editor must run in a plain browser against the sample project.
- No em-dashes or emojis in code, docs or commits.

## Review Focus

1. A cut covering the whole video, or two overlapping cuts: the output must not break (empty or merged segments).
2. `events.jsonl` with only a header, or empty: editor opens, no cursor drawn, auto zoom returns nothing.
3. A project with no `mic` track or a negative mic `offsetUs`: playback still starts and stays in sync.
4. A zoom whose rect extends outside 0 to 1, or whose end is before its start: clamped or rejected, never crashes the compositor.
5. Auto zoom on a single click, and on clicks closer together than the ease time: no overlapping or zero-length zooms.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore` (add `node_modules`, `dist`, `samples/`, `target/`)
- Create: `packages/format/package.json`, `packages/timeline/package.json`, `packages/compositor/package.json` (each `"type": "module"`, name `@marz/<dir>`, `"main": "src/index.ts"`, each with an empty `src/index.ts`)

**Interfaces:**
- Produces: workspace packages `@marz/format`, `@marz/timeline`, `@marz/compositor` importable by name; root scripts `pnpm test` (vitest run, all packages) and `pnpm typecheck` (tsc --noEmit per package).

- [ ] **Step 1: Create the files above; `@marz/timeline` and `@marz/compositor` depend on `@marz/format` via `workspace:*`; `zod` is a dependency of `@marz/format`.**
- [ ] **Step 2: Add `packages/format/src/smoke.test.ts` asserting `1 + 1 === 2`.**
- [ ] **Step 3: Run `pnpm install && pnpm test && pnpm typecheck`. Expected: 1 test passes, typecheck clean. Delete the smoke test.**
- [ ] **Step 4: Commit** (`git pull --rebase` first; stage the files by name): `chore: scaffold pnpm monorepo`

### Task 2: Format types and project validator

**Files:**
- Create: `packages/format/src/project.ts`, `packages/format/src/index.ts`
- Test: `packages/format/src/project.test.ts`

**Interfaces:**
- Produces: types `Rect {x,y,w,h: number}`, `Zoom`, `Cut`, `ZoomPreset`, `Project` exactly as in the design doc's `project.json`; `parseProject(json: unknown): Project` (throws `FormatError` with a readable message); `serializeProject(p: Project): string` (2-space JSON, trailing newline); `class FormatError extends Error`.

- [ ] **Step 1: Write failing tests in `project.test.ts`:**
  - `parses the design-doc example`: the full example from the design doc round-trips through `parseProject` then `serializeProject` then `parseProject` to a deep-equal object.
  - `preserves unknown fields`: input with `"futureThing": {"a":1}` at top level and `"edits": {"layout": []}` still has both after `parseProject` + `serializeProject`.
  - `rejects wrong version`: `version: 2` throws `FormatError` whose message contains `"version"`.
  - `rejects missing screen track`: throws `FormatError` mentioning `"tracks.screen"`.
  - `accepts a project without mic`.
- [ ] **Step 2: Run `pnpm --filter @marz/format test`. Expected: FAIL (module missing).**
- [ ] **Step 3: Implement with zod; every object schema uses `.passthrough()` so unknown fields survive. `tracks.mic` optional. `edits.zooms` and `edits.cuts` default to `[]`.**
- [ ] **Step 4: Run tests. Expected: PASS.**
- [ ] **Step 5: Commit:** `feat(format): project.json types and validator`

### Task 3: Events parser

**Files:**
- Create: `packages/format/src/events.ts` (export from `index.ts`)
- Test: `packages/format/src/events.test.ts`

**Interfaces:**
- Produces: `type MarzEvent = CursorEvent | ClickEvent | ZoomEvent | PauseEvent | ResumeEvent` (shapes per the design doc, all with `tUs`), `type EventsHeader {version: 1; source: {width,height,fps}; startedAt: string}`, `parseEvents(text: string): { header: EventsHeader; events: MarzEvent[] }`.

- [ ] **Step 1: Write failing tests:**
  - `parses header and events in order` using the design-doc sample lines.
  - `ignores unknown event types` (a `{"tUs":1,"type":"stroke"}` line is skipped, not thrown).
  - `drops an unparseable final line` (text ends mid-JSON; earlier events are returned).
  - `throws on a bad middle line` (`FormatError`; only the final line is forgiven).
  - `header only` returns `events: []`.
  - `empty text` throws `FormatError` mentioning `"header"`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(format): events.jsonl parser`

### Task 4: Sample project generator

**Files:**
- Create: `tools/make-sample/make-sample.ts`, `tools/make-sample/package.json` (script `make-sample`, runs with `tsx`), root script `pnpm sample`
- Test: `tools/make-sample/make-sample.test.ts`

**Interfaces:**
- Consumes: `parseProject`, `parseEvents`, `serializeProject` from `@marz/format`.
- Produces: `makeSample(outDir: string, opts?: { durationSec?: number }): Promise<void>` writing `outDir/project.json`, `events.jsonl`, `screen.mp4`, `mic.wav`. Defaults: 20 s, 1920x1080, 30 fps. Output used by every later editor task at `samples/demo.marz`.

- [ ] **Step 1: Write failing test `generates a valid project`:** run `makeSample` into a temp dir with `durationSec: 3`; assert `parseProject` and `parseEvents` accept the files, `events` contains at least 2 `click` events and 1 `cursor` event, and `ffprobe` reports video duration within 0.2 s of 3 s and audio sample rate 48000.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Video: FFmpeg `testsrc2` with a burned-in running timecode (so sync is visible by eye), `libx264`, `-movflags frag_keyframe+empty_moov`, constant fps. Audio: a 440 Hz tone plus a click track every second (so audio/video sync is audible and visible). Events: a cursor path moving between three screen areas; click pairs (down/up) clustered in two regions; mic `offsetUs` of 12400.
- [ ] **Step 4: Run test, expect PASS. Run `pnpm sample` to create `samples/demo.marz` (gitignored).**
- [ ] **Step 5: Commit:** `feat: sample project generator`

### Task 5: Cut mapping (source time to output time)

**Files:**
- Create: `packages/timeline/src/segments.ts`
- Test: `packages/timeline/src/segments.test.ts`

**Interfaces:**
- Produces: `type Segment {srcStartUs: number; srcEndUs: number; outStartUs: number}`; `keptSegments(durationUs: number, cuts: Cut[]): Segment[]` (sorts, clamps to `[0, durationUs]`, merges overlaps, drops zero-length cuts); `outputDurationUs(segs: Segment[]): number`; `sourceToOutput(segs, srcUs): number | null` (null when inside a cut); `outputToSource(segs, outUs): number`.

- [ ] **Step 1: Write failing tests:** no cuts gives one segment `[0, D]`; one middle cut gives two segments with correct `outStartUs`; overlapping cuts `[2,5]` and `[4,8]` merge; a cut covering everything gives `[]` and `outputDurationUs` 0; a cut starting before 0 or ending past D is clamped; `sourceToOutput` returns null inside a cut and the shifted value after it; `outputToSource` is the inverse for kept times.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(timeline): cut to segment mapping`

### Task 6: Zoom evaluation and aspect lock

**Files:**
- Create: `packages/timeline/src/zoom.ts`
- Test: `packages/timeline/src/zoom.test.ts`

**Interfaces:**
- Produces: `FULL_RECT: Rect` (`{0,0,1,1}`); `ease(name: Zoom['easing'], p: number): number`; `zoomRectAt(zooms: Zoom[], tUs: number): Rect` (full rect outside any zoom; interpolates from `FULL_RECT` to `rect` over `easeInUs` at the start and back over `easeOutUs` at the end; if two zooms overlap, the later `startUs` wins); `clampRect(r: Rect): Rect` (inside 0 to 1, min size 0.05); `lockAspect(r: Rect, aspect: number, source: {width: number; height: number}): Rect` (adjusts height so `(w*sw)/(h*sh) === aspect`, keeps center, then clamps).

- [ ] **Step 1: Write failing tests:** `zoomRectAt` returns `FULL_RECT` before the first zoom; equals the zoom rect at the midpoint of a long zoom; is halfway (for `linear`) at half of `easeInUs`; `ease('easeInOutCubic', 0.5) === 0.5`, `ease(..., 0) === 0`, `ease(..., 1) === 1`; a zoom with `endUs <= startUs` is ignored; `clampRect({x:0.9,y:0.9,w:0.5,h:0.5})` stays inside the unit square; `lockAspect` of a 16:9 source with aspect 16/9 yields `w === h`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(timeline): zoom evaluation and aspect lock`

### Task 7: Auto zoom suggestions

**Files:**
- Create: `packages/timeline/src/autozoom.ts`
- Test: `packages/timeline/src/autozoom.test.ts`

**Interfaces:**
- Consumes: `MarzEvent`, `EventsHeader['source']`, `lockAspect`, `clampRect`.
- Produces: `suggestZooms(events: MarzEvent[], source: {width,height}, outputAspect: number, opts?: { clusterGapUs?: number; paddingUs?: number; zoomScale?: number; minGapUs?: number }): Zoom[]`. Defaults: `clusterGapUs` 2,000,000; `paddingUs` 600,000; `zoomScale` 0.5 (rect covers 50% of the source width); `minGapUs` 800,000. Returned zooms have `origin: "auto"`, ids `auto-1`, `auto-2`, ..., `easeInUs` and `easeOutUs` 400,000, `easing: "easeInOutCubic"`.

- [ ] **Step 1: Write failing tests:** no events gives `[]`; a single click gives `[]` (one click is not a cluster); three `down` clicks within 1 s of each other in one region give exactly one zoom centered on their mean, aspect-locked; two clusters 10 s apart give two non-overlapping zooms; clusters whose padded ranges would overlap or sit closer than `minGapUs` are merged into one zoom; every suggestion has `endUs > startUs` and a rect inside 0 to 1.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Use only `click` events with `state: "down"`. Group by time gap, then centre the rect on the cluster mean, widen to include all cluster points if they do not fit.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(timeline): auto zoom from click clusters`

### Task 8: Edit history (commands, undo, redo)

**Files:**
- Create: `packages/timeline/src/history.ts`, `packages/timeline/src/commands.ts`
- Test: `packages/timeline/src/history.test.ts`

**Interfaces:**
- Consumes: `Project`, `Zoom`, `Cut`.
- Produces: `class History { constructor(initial: Project); readonly current: Project; canUndo: boolean; canRedo: boolean; apply(command: (p: Project) => Project): void; undo(): void; redo(): void; subscribe(fn: () => void): () => void }` (applying after an undo clears redo; keeps at most 200 steps). Commands in `commands.ts`, each returning a `(p: Project) => Project`: `addZoom(z: Zoom)`, `updateZoom(id: string, patch: Partial<Zoom>)`, `removeZoom(id: string)`, `addCut(c: Cut)`, `updateCut(id: string, patch: Partial<Cut>)`, `removeCut(id: string)`, `replaceAutoZooms(zs: Zoom[])` (removes all `origin: "auto"` zooms, adds `zs`), `setCursorHidden(hidden: boolean)`. All are pure and never mutate the input.

- [ ] **Step 1: Write failing tests:** apply then undo restores the exact previous object (`toBe` identity); redo reapplies; apply after undo drops redo; `updateZoom` on a missing id is a no-op that does not add a history entry; `replaceAutoZooms` keeps `live` and `manual` zooms; commands do not mutate their input (deep-freeze the input in the test); unknown project fields survive every command.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(timeline): edit history and commands`

### Task 9: Compositor (single renderer for preview and export)

**Files:**
- Create: `packages/compositor/src/frame.ts`, `packages/compositor/src/draw.ts`
- Test: `packages/compositor/src/frame.test.ts`

**Interfaces:**
- Consumes: `Project`, `MarzEvent`, `zoomRectAt`.
- Produces: `type FrameSpec { srcRect: {sx,sy,sw,sh: number}; cursor: {x: number; y: number} | null }` (source rect in source pixels; cursor in output pixels); `frameAt(project: Project, events: MarzEvent[], srcUs: number): FrameSpec` (cursor is the latest `cursor` event at or before `srcUs`, mapped through `srcRect` to output pixels, null when none, hidden, or outside the rect; no smoothing); `drawFrame(ctx: CanvasRenderingContext2D, source: CanvasImageSource, spec: FrameSpec, out: {width: number; height: number}): void` (draws the crop scaled to `out`, then a standard arrow sprite at the cursor). Events are expected sorted; use binary search for the cursor lookup.

- [ ] **Step 1: Write failing tests:** no zooms gives the full source rect; inside a zoom (after ease-in) `srcRect` equals the zoom rect times source dims; cursor at the last sample at or before `srcUs`, exact values with no interpolation; cursor outside the zoom rect gives null; `edits.cursor.hidden: true` gives null; empty events gives null cursor; a zoom with rect outside 0 to 1 still yields a `srcRect` inside the source frame.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement (`draw.ts` is thin and untested here; it is checked in the browser in Task 12). Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit:** `feat(compositor): frameAt and drawFrame`

### Task 10: Storage interface, dev server, autosave

**Files:**
- Create: `apps/desktop/` (Vite + React + TypeScript + Tailwind + Zustand scaffold; package name `@marz/desktop`; depends on all three packages), `apps/desktop/src/storage/types.ts`, `apps/desktop/src/storage/httpStorage.ts`, `apps/desktop/vite-plugin-projects.ts`, `apps/desktop/src/storage/autosave.ts`
- Test: `apps/desktop/src/storage/autosave.test.ts`

**Interfaces:**
- Produces: `interface ProjectStorage { readText(path: string): Promise<string>; fileUrl(path: string): string; writeProjectJson(text: string): Promise<void> }`; `createHttpStorage(projectName: string): ProjectStorage`; Vite plugin serving `samples/<name>.marz/*` at `/projects/<name>/*` with HTTP range support (video seeking) and accepting `PUT /projects/<name>/project.json` only (any other write returns 403); `createAutosave(save: () => Promise<void>, delayMs: number): { schedule(): void; flush(): Promise<void> }` (debounced, a flush with nothing pending does nothing).

- [ ] **Step 1: Write failing tests for `createAutosave` with fake timers:** several `schedule()` calls within `delayMs` produce one `save`; `flush()` saves immediately and cancels the timer; `flush()` with nothing pending does not call `save`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement autosave, then the plugin and HTTP storage. Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Verify by hand:** `pnpm --filter @marz/desktop dev`, then `curl -I -H "Range: bytes=0-99" http://localhost:5173/projects/demo/screen.mp4` returns `206`, and `curl -X PUT http://localhost:5173/projects/demo/screen.mp4` returns `403`.
- [ ] **Step 6: Commit:** `feat(desktop): editor app scaffold, storage interface, autosave`

### Task 11: Editor shell with synced playback

**Files:**
- Create: `apps/desktop/src/state/editorStore.ts`, `apps/desktop/src/playback/usePlayback.ts`, `apps/desktop/src/components/Preview.tsx`, `apps/desktop/src/App.tsx`
- Test: `apps/desktop/src/playback/clock.test.ts` (pure helpers only)

**Interfaces:**
- Consumes: `ProjectStorage`, `History`, `frameAt`, `drawFrame`, `keptSegments`, `outputToSource`.
- Produces: `editorStore` (Zustand) with `project`, `events`, `history`, `playheadOutUs`, `playing`, actions `load(name)`, `play()`, `pause()`, `seekOut(us)`, `apply(command)`, `undo()`, `redo()`; `nextPlaybackTime(segs: Segment[], srcUs: number): number | null` in `playback/clock.ts` (returns `srcUs`, or the start of the next kept segment when `srcUs` is inside a cut, or null at the end).

- [ ] **Step 1: Write failing tests for `nextPlaybackTime`:** outside cuts returns the same time; inside a cut jumps to the cut end; after the last segment returns null.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement the helper, then the store, then playback.** Playback: the `<video>` element is the clock; each `requestAnimationFrame` reads `video.currentTime`, applies `nextPlaybackTime` (skip over cuts by setting `currentTime`), draws the frame with `drawFrame` to the preview canvas, and keeps a hidden `<audio>` for `mic.wav` within 40 ms of the video, offset by `tracks.mic.offsetUs`. `App` loads `demo` by default (`?project=name` overrides).
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Check in the browser (built-in browser pane):** open the dev URL; the sample plays, the burned-in timecode and the audible click track stay aligned, space toggles play, a cut added from the console skips over its range. Report what was seen.
- [ ] **Step 6: Commit:** `feat(desktop): editor shell with synced playback`

### Task 12: Timeline, inspector, canvas zoom editing, auto zoom, undo, autosave

**Files:**
- Create: `apps/desktop/src/components/Timeline.tsx`, `apps/desktop/src/components/Inspector.tsx`, `apps/desktop/src/components/ZoomOverlay.tsx`, `apps/desktop/src/components/Toolbar.tsx`
- Modify: `apps/desktop/src/App.tsx`, `apps/desktop/src/state/editorStore.ts` (selection, autosave wiring)
- Test: `apps/desktop/src/components/timelineMath.test.ts` for the pure drag math in `timelineMath.ts`

**Interfaces:**
- Consumes: `commands`, `suggestZooms`, `lockAspect`, `keptSegments`, `createAutosave`.
- Produces: `timelineMath.ts`: `usToPx(us: number, pxPerSec: number): number`, `pxToUs(px: number, pxPerSec: number): number`, `snapUs(us: number, targets: number[], thresholdUs: number): number`.

- [ ] **Step 1: Write failing tests for `timelineMath`:** `pxToUs(usToPx(x))` round-trips within 1 us; `snapUs` snaps to a target within the threshold and leaves other values alone.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement the math.**
- [ ] **Step 4: Implement the UI.** Timeline: ruler, playhead (click and drag to seek), one lane with zoom blocks (blue) and cut blocks (red hatched); drag to move, edge-drag to trim, Delete key removes the selection, click on empty lane then "Add cut" button adds a cut at the playhead (2 s). Inspector shows only the selected item: zoom (start, end, ease in and out, easing, origin badge) or cut (start, end), and project-level cursor-hidden toggle when nothing is selected. `ZoomOverlay` on the preview canvas: the selected zoom's rect is draggable and resizable with the aspect locked via `lockAspect`. Toolbar: Play, Add zoom (at playhead, rect centered), Auto zoom (calls `suggestZooms` then `replaceAutoZooms`), Undo, Redo; Ctrl+Z and Ctrl+Shift+Z. Every tool has an icon, a hover label, and the hotkey in the tooltip. Autosave: every `apply` and `undo` and `redo` calls `schedule()` with a 2000 ms delay; `flush()` on window `beforeunload`. Dark theme, one accent colour.
- [ ] **Step 5: Run tests, expect PASS.**
- [ ] **Step 6: Check in the browser (built-in pane; Playwright only if asked), report what was seen:** auto zoom on the sample creates zooms near the two click regions; dragging a zoom block moves it and the preview zooms at the new time; dragging the rect on the canvas keeps 16:9; Ctrl+Z reverts each; after 3 s `samples/demo.marz/project.json` on disk contains the edits and still has all unknown fields; `screen.mp4`, `mic.wav` and `events.jsonl` are byte-identical to before (compare hashes).
- [ ] **Step 7: Commit:** `feat(desktop): timeline, inspector, zoom editing, auto zoom, undo, autosave`

---

## Self-review notes

- Spec coverage: format contract (Tasks 2, 3), sample project (4), cuts (5), zoom blocks and easing (6), auto zoom (7), undo/redo (8), one renderer (9), storage interface and browser run (10), synced playback (11), timeline and inspector and autosave (12). Capture, Tauri, recorder toolbar and export are deliberately in later plans.
- Type names used across tasks: `Rect`, `Zoom`, `Cut`, `Project`, `MarzEvent`, `Segment`, `FrameSpec`, `History`, `ProjectStorage` are each defined once and reused unchanged.
- Gap to confirm with Mauricio: timeline visuals wait on the design pass (spec section 14). Task 12 uses a plain dark layout until then.
