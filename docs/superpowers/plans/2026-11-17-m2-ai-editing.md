# M2 AI Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Stop, the editor opens with silences, ums and mistakes cut, zooms placed and captions on, all as normal undoable edits; Mauricio reviews and exports.

**Architecture:** Three stages behind interfaces. Transcription runs in Rust (`crates/transcribe`) through a `whisper.cpp` sidecar and writes `transcript.json`. A pure TypeScript package `packages/autoedit` turns the transcript, mic levels, click candidates and an optional AI result into cuts, zooms and caption lines, and produces one `applyAiPass` command for the existing `History`. The AI result comes from an `AiProvider`: `ClaudeCodeProvider` runs the installed Claude Code CLI (`claude -p`, his subscription) from Rust; `FakeProvider` serves the browser and tests. Captions are drawn by the compositor, so preview and export match.

**Tech Stack:** TypeScript, React, Zustand, Vitest, Rust 2024, Tauri 2, `serde`/`serde_json`, `whisper.cpp` CLI sidecar, Claude Code CLI sidecar, FFmpeg (already used), Edge via Playwright for UI checks.

**Spec:** `docs/superpowers/specs/2026-11-17-milestone-2-ai-editing-design.md`. Format contract it extends: `docs/superpowers/specs/2026-11-15-milestone-1-design.md`. Design (binding): `docs/design/avant-garde/DESIGN-SYSTEM.md`.

**Status:** APPROVED by Mauricio on 2026-11-18. Execution: subagent-driven (fresh agent per task plus a reviewer), his pick.

**Branch:** start from `claude/capture-plan-d523b6` (M1, PR 1) or from main once PR 1 is merged. File paths below are as they are on that branch.

## Global Constraints

- Raw tracks (`screen.mp4`, `mic.wav`, `events.jsonl`) are never modified. Transcription reads a 16 kHz mono copy written to a temp folder outside the project.
- Only text leaves the PC: transcript words, word timings, the numeric zoom candidates. Never video, audio or file paths.
- The AI never invents coordinates: zoom rects come only from `suggestZooms` candidates.
- Time is integer microseconds in source time (`...Us`). Transcript times add `tracks.mic.offsetUs`.
- Every AI edit has `origin: "ai"`. Changing one makes it `"manual"`. A rerun only replaces `"ai"` (and untouched `"auto"`) edits. One pass = one `History` step.
- Format changes are additive and approved (2026-11-17): `transcript.json`, cut `origin` + `reason`, zoom origin `"ai"` + `candidateId`, `edits.captions`, `edits.ai`. Readers become tolerant first: an unknown `origin` or `easing` is read as `"manual"` / `"easeInOutCubic"` and the original value is preserved on save.
- Dependencies: only the `whisper.cpp` CLI and its models (approved) and the already installed Claude Code CLI. No `reqwest`, no `keyring`, no API key, no new npm packages. Any other dependency needs Mauricio's yes.
- Claude Code is run as: `claude -p --output-format json --json-schema <schema> --tools "" --no-session-persistence --strict-mcp-config --setting-sources "" --model <setting, default sonnet>`, prompt on stdin, working directory an empty temp folder. Found via `MARZ_CLAUDE`, then PATH.
- Whisper is found via `MARZ_WHISPER`, beside the exe, then PATH. Models live in the app data folder `models/`, downloaded only after he confirms the size.
- Language is detected per section (pt and en mixed in one take). Pure fillers: `um`, `uh`, `erm`, `hmm`, `ã`, `hum`, `ahn`, stretched forms (`umm`, `éé`, `ããã`), and a lone `é` held 0.4 s or more between pauses. Everything else that may be filler (`é`, `tipo`, `né`, `like`, `you know`, `so`, `então`) goes to Claude.
- Defaults (tuned in Task 1): silence gap 800 ms, pace padding 300 ms (slider range 80 to 600 ms), caption line max 32 characters, highlight line 1 to 4 words, AI chunks of 20 min with 30 s overlap above 30 min.
- The editor keeps running in a plain browser against `samples/demo.marz`; no Tauri call on the browser path. Windows-only code lives in `crates/transcribe` and `apps/desktop/src-tauri`. Each task says **Where:** it can be built and tested; never claim a Windows task works unless it ran on Windows.
- UI: `DESIGN-SYSTEM.md` is binding. Every new piece (status line texts, AI tag, reason labels, Captions lane, caption looks, AI inspector panel, Edit with AI row, Burn captions toggle) is written into `DESIGN-SYSTEM.md` in its style before it is built, and rule 12 is amended to allow captions and the AI pass. Before every UI commit: `pnpm design:check` passes and Edge screenshots at 1440 x 900 and 1280 x 720 of each changed state; deviations go in `DEVIATIONS.md`.
- Copy: sentence case, verbs first, no "successfully", "please", emoji. No em-dashes anywhere.
- Before each commit: `git pull --rebase`, stage files by name. Run `pnpm test && pnpm typecheck` (and `cargo test` for Rust tasks).

## Review Focus

1. **No speech at all** (silent take, muted mic, no mic track): the pass finishes with "No speech found. Nothing was cut." and changes nothing; captions lane empty. Test: Task 4 (`no words gives no cuts`), Task 13 (`no mic track skips transcription`).
2. **Whisper hallucinates text on silence** ("Obrigado.", "Thanks for watching" over a quiet stretch): words whose span has mic level below the silence floor are dropped before rules and captions. Test: Task 4 (`drops words over silent audio`).
3. **Claude returns bad output** (unknown word ids, reversed ranges, overlapping ranges, invalid JSON, or cuts covering most of the take): invalid items dropped; a result that would cut more than 50% of the spoken words is refused whole with "AI result looked wrong. Mistakes and AI zooms were skipped." Test: Task 11 (`validator drops unknown ids`, `refuses a result that cuts most words`).
4. **He edits, closes the project or opens another one while the pass runs:** edits made during the run win (overlapping AI edits dropped); closing aborts the run and nothing is written to any project. Test: Task 6 (`edits during the run win`), Task 14 (`closing the project aborts the pass`).
5. **Very long take (over 30 min):** sent in chunks; a mistake found twice in the overlap is applied once. Test: Task 11 (`chunks over 30 minutes and dedupes the overlap`).

---

## Part A: Spike (Windows)

### Task 1: Whisper and Claude Code spike

**Where:** Windows only. Throwaway scripts, not shipped.

**Files:**
- Create: `docs/spikes/2026-11-xx-ai-spike.md` (results), `tools/ai-spike/` (scripts, may be deleted after)

- [ ] **Step 1:** Mauricio records three takes of 2 to 3 minutes each with M1 (one pt-BR, one English, one switching language mid-take), each with deliberate ums, one restarted sentence and one repeated take. Ask him; this is his action.
- [ ] **Step 2:** Get the `whisper.cpp` Windows release (CUDA build and CPU build) and `ggml-large-v3-turbo-q5_0.bin` and `ggml-small.bin`. Transcribe each take with word timestamps (`-ojf`, `-ml 1 -sow`), once with `-l auto` on the whole file and once per section split at pauses over 1 s, with and without a filler prompt (`--prompt "Umm, uh, é, ããã, tipo, né. So, um, like."`).
- [ ] **Step 3:** Record in the spike doc: seconds of processing per minute of audio (GPU turbo, CPU small), how many deliberate ums survive per variant, word start error against the waveform for 20 words, whether per-section detection gets the language right on the switching take, and any hallucinated words over silence.
- [ ] **Step 4:** Send one transcript to `claude -p` with the flags from Global Constraints and a draft schema (`mistakes`, `contextFillers`, `zooms`). Record: does it find the restarted sentence and the repeated take, wall time, and how much of his plan's usage one call took (from `/usage` or the JSON `usage` field).
- [ ] **Step 5:** Set the thresholds in Global Constraints from the numbers (silence gap, padding, filler prompt, section length, GPU vs CPU default). Update this plan's Global Constraints and the spec if a number changes.
- [ ] **Step 6: Commit:** `docs: AI spike results for whisper.cpp and Claude Code`

**Stop rule:** if fewer than half of the deliberate ums survive in every variant, stop and tell Mauricio before Task 4: filler cuts would then need audio-based detection (gaps with voice energy but no word), which changes Task 4.

---

## Part B: Format (anywhere)

### Task 2: Tolerant readers and the new edit fields

**Where:** anywhere.

**Files:**
- Modify: `packages/format/src/project.ts`, `packages/format/src/project.test.ts`

**Interfaces:**
- Produces in `@marz/format`:
  - `type CutReason = "silence" | "filler" | "mistake"`; `Cut` gains `origin?: "manual" | "ai"` (absent = manual) and `reason?: CutReason`.
  - `Zoom.origin` accepts `"live" | "auto" | "manual" | "ai"`; `Zoom` gains `candidateId?: string`.
  - `type CaptionEdits = { overrides: Record<string, string>; hidden: string[] }`; `Project.edits.captions?: CaptionEdits`.
  - `type AiKinds = { silences: boolean; fillers: boolean; mistakes: boolean; zooms: boolean; captions: boolean }`.
  - `type RejectedAiEdit = { kind: "cut"; reason: CutReason; fromWordId: string; toWordId: string } | { kind: "zoom"; candidateId: string }`.
  - `type AiEdits = { paceUs: number; kinds: AiKinds; rejected: RejectedAiEdit[]; lastRun?: { at: string; provider: string; model: string; languages: string[] }; lastResult?: AiResult }` with `AiResult` defined in Task 11 and re-exported here as an opaque passthrough (`z.unknown()` in the schema, typed by `@marz/autoedit`).
  - `Project.edits.ai?: AiEdits`. Constant `DEFAULT_AI_EDITS: AiEdits` (`paceUs: 300000`, all kinds true, `rejected: []`).

- [ ] **Step 1: Write failing tests** in `project.test.ts`: `reads an M1 project unchanged` (round trip equal); `unknown zoom origin reads as manual and saves the original` (`"origin":"robot"` parses, `serializeProject` writes `"robot"` back); `unknown easing reads as easeInOutCubic and saves the original`; `cut origin and reason round trip`; `captions and ai edits round trip`; `unknown fields inside edits.ai are preserved`.
- [ ] **Step 2:** Run `pnpm --filter @marz/format test`. Expected: FAIL.
- [ ] **Step 3:** Implement with `z.preprocess`/`catch` on the enums, keeping the raw value in the passthrough so save writes it back.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck`. Expected: PASS (all M1 tests still pass).
- [ ] **Step 5: Commit:** `feat(format): tolerant enums and the M2 edit fields`

### Task 3: `transcript.json` schema and the sample transcript

**Where:** anywhere.

**Files:**
- Create: `packages/format/src/transcript.ts`, `packages/format/src/transcript.test.ts`
- Modify: `packages/format/src/index.ts`, `tools/make-sample/make-sample.ts`, `tools/make-sample/make-sample.test.ts`, `apps/desktop/src/storage/types.ts` (no change needed if `readText` covers it; add `readTranscript(): Promise<Transcript | null>` helper in `apps/desktop/src/storage/transcript.ts`)

**Interfaces:**
- Produces: `type Word = { id: string; text: string; startUs: number; endUs: number; p: number }`, `type Section = { startUs: number; endUs: number; language: string }`, `type Transcript = { version: 1; engine: string; mic: { bytes: number; modifiedAt: string }; sections: Section[]; words: Word[] }`, `parseTranscript(json: unknown): Transcript` (drops words with `endUs <= startUs`, sorts by `startUs`, keeps unknown fields), `languageAt(t: Transcript, us: number): string | undefined`.
- Sample: `pnpm sample` writes `samples/demo.marz/transcript.json` with two sections (pt then en), about 60 words timed inside the sample's length, including `umm`, a lone stretched `é`, `tipo`, a restarted sentence ("Agora a gente vai, agora a gente vai abrir o menu"), and a 2 s gap.

- [ ] **Step 1: Write failing tests:** `parses a valid transcript`; `drops zero-length words`; `sorts words by start`; `languageAt picks the section`; in make-sample: `writes a transcript that parses and fits the duration`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm test && pnpm typecheck`, expect PASS.
- [ ] **Step 5: Commit:** `feat(format): transcript.json schema and sample transcript`

---

## Part C: Rules and apply (anywhere)

### Task 4: Silence and filler rules (`packages/autoedit`)

**Where:** anywhere.

**Files:**
- Create: `packages/autoedit/package.json` (`@marz/autoedit`, deps `@marz/format`, `@marz/timeline`), `packages/autoedit/tsconfig.json`, `packages/autoedit/src/index.ts`, `src/levels.ts`, `src/rules.ts`, `src/fillers.ts`, `src/rules.test.ts`, `src/levels.test.ts`

**Interfaces:**
- Produces:
  - `type Levels = { stepUs: 10000; rms: Float32Array; floor: number }` and `micLevels(wav: ArrayBuffer, offsetUs: number): Levels` (48 kHz s16 mono WAV from M1; `floor` = 20th percentile RMS times 2).
  - `isPureFiller(word: Word, prevGapUs: number, nextGapUs: number): boolean` using the list in Global Constraints.
  - `type CutSpan = { startUs: number; endUs: number; reason: CutReason; fromWordId: string; toWordId: string }` (for a silence, `fromWordId`/`toWordId` are the words on each side).
  - `cleanWords(words: Word[], levels: Levels | null): Word[]` (drops words over silent audio).
  - `ruleCuts(words: Word[], levels: Levels | null, opts: { silenceGapUs: number; paceUs: number; durationUs: number }): CutSpan[]` (silences: gap minus `paceUs` on each side, only when the gap's mean level is under `floor` or levels are null; fillers: the filler word plus the gap around it minus `paceUs`; merged when they touch; clamped to `[0, durationUs]`).

- [ ] **Step 1: Write failing tests:** `cuts a 2 s gap leaving 300 ms each side`; `ignores a 500 ms gap`; `keeps a gap that has voice in it`; `cuts umm and éé`; `keeps a short é between words`; `cuts a lone é held 450 ms`; `merges a filler next to a silence`; `clamps to the duration`; `no words gives no cuts`; `drops words over silent audio`; `pace 80 ms gives tighter cuts than 600 ms`; levels: `reads the sample mic.wav at 10 ms steps`.
- [ ] **Step 2:** Run `pnpm --filter @marz/autoedit test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(autoedit): silence and filler cut rules`

### Task 5: Building the AI edit set

**Where:** anywhere.

**Files:**
- Create: `packages/autoedit/src/build.ts`, `src/build.test.ts`

**Interfaces:**
- Consumes: `ruleCuts`, `CutSpan` (Task 4); `suggestZooms` from `@marz/timeline`; `AiResult` (Task 11 type, declared in `src/ai/types.ts` in this task as a type only so Task 11 fills the logic).
- Produces: `type ZoomCandidate = { id: string; startUs: number; endUs: number; rect: Rect }`, `zoomCandidates(events: MarzEvent[], project: Project): ZoomCandidate[]` (wraps `suggestZooms`, ids `k1..kN` stable by start time), `buildAiEdits(input: { project: Project; words: Word[]; levels: Levels | null; candidates: ZoomCandidate[]; ai: AiResult | null }): { cuts: Cut[]; zooms: Zoom[] }` (respects `edits.ai.kinds` and `edits.ai.paceUs`; skips anything in `edits.ai.rejected`; mistake and context filler ranges become cuts with `paceUs`; chosen candidates become zooms spanning `from`/`to` word times with M1 default easing; all with `origin: "ai"`).

- [ ] **Step 1: Write failing tests:** `rule cuts become ai cuts with reasons`; `kinds off removes that kind`; `rejected silence stays out by word ids even after pace changes`; `rejected zoom candidate stays out`; `ai mistake range becomes a mistake cut`; `ai zoom uses the candidate rect and word times`; `no ai result gives rule cuts only and no zooms`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit:** `feat(autoedit): build AI cuts and zooms from rules and the AI result`

### Task 6: `applyAiPass` and the rerun rules

**Where:** anywhere.

**Files:**
- Modify: `packages/timeline/src/commands.ts`, `packages/timeline/src/history.test.ts`
- Create: `packages/timeline/src/aiCommands.test.ts`

**Interfaces:**
- Produces in `@marz/timeline`:
  - `applyAiPass(next: { cuts: Cut[]; zooms: Zoom[] }, guard: { touchedSince: Array<{ startUs: number; endUs: number }> }, meta: AiEdits["lastRun"] & { result: AiResult | null }): Command` (removes `"ai"` cuts and zooms and untouched `"auto"` zooms; drops new edits overlapping `guard.touchedSince` or any `"manual"`/`"live"` edit of the same kind; writes `edits.ai.lastRun` and `lastResult`; returns `p` unchanged when nothing differs).
  - `updateZoom` and `updateCut` set `origin: "manual"` when the patch changes time or rect of an `"ai"` edit.
  - `removeZoom` and `removeCut` on an `"ai"` edit append to `edits.ai.rejected` in the same step.
  - `setAiPace(paceUs: number, rebuilt: { cuts: Cut[] }): Command` and `setAiKinds(kinds: AiKinds, rebuilt: { cuts: Cut[]; zooms: Zoom[] }): Command` (replace `"ai"` edits only, no Claude call).
  - `touchedRanges(before: Project, after: Project): Array<{ startUs: number; endUs: number }>` (ranges of cuts and zooms added, changed or removed between two projects; captions changes ignored).

- [ ] **Step 1: Write failing tests:** `one pass is one undo step`; `undo after a pass restores the project exactly`; `rerun keeps manual edits`; `tweaking an ai zoom makes it manual`; `deleting an ai cut records it as rejected and undo removes the record`; `edits during the run win` (cut added in the guard range drops the overlapping AI cut); `ai pass replaces untouched auto zooms`; `pressing A later replaces only auto zooms and skips clusters overlapping ai zooms` (update `replaceAutoZooms`); `pass with identical result adds no undo step`.
- [ ] **Step 2:** Run `pnpm --filter @marz/timeline test`, expect FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm test && pnpm typecheck`, expect PASS.
- [ ] **Step 5: Commit:** `feat(timeline): one-step AI pass with rerun and reject rules`

### Task 7: AI tags and cut reasons on the timeline

**Where:** anywhere (browser against the sample, with a fixture pass applied from the dev console helper `window.__marz.applyFixtureAiPass()` added in this task, dev builds only).

**Files:**
- Modify: `docs/design/avant-garde/DESIGN-SYSTEM.md` (AI tag on caps, reason labels "Silence", "Um", "Mistake", footer "8 zooms / 23 cuts / 6 by AI", rule 12 amended), `apps/desktop/src/components/Timeline.tsx`, `apps/desktop/src/components/Lanes.tsx`, `apps/desktop/src/components/zoomLabels.ts`, `apps/desktop/src/styles/editor.css`

- [ ] **Step 1:** Write the additions into `DESIGN-SYSTEM.md` first, in its style (sizes from the existing micro type, colours from tokens only).
- [ ] **Step 2:** Implement. Cut caps show the reason; AI-origin blocks show the tag; footer counts AI edits.
- [ ] **Step 3:** Run `pnpm design:check`. Expected: pass. Screenshot the timeline with the fixture pass at 1440 x 900 and 1280 x 720 in Edge; compare against the DESIGN-SYSTEM text; note deviations in `DEVIATIONS.md`.
- [ ] **Step 4: Commit:** `feat(editor): AI tags and cut reasons on the timeline`

---

## Part D: Captions (anywhere)

### Task 8: Caption lines and SRT

**Where:** anywhere.

**Files:**
- Create: `packages/autoedit/src/captions.ts`, `src/srt.ts`, `src/captions.test.ts`, `src/srt.test.ts`

**Interfaces:**
- Consumes: `Word`, `CaptionEdits`, `Cut`; the source-to-output time mapping in `@marz/timeline` `segments.ts`.
- Produces: `type CaptionLook = "subtitles" | "highlight"`, `type CaptionWord = { id: string; text: string; startUs: number; endUs: number }` (output time), `type CaptionLine = { startUs: number; endUs: number; words: CaptionWord[] }`, `captionLines(project: Project, words: Word[], look: CaptionLook): CaptionLine[]` (removes words inside cuts and `hidden`, applies `overrides`, maps to output time, breaks at sentence ends, pauses over 600 ms, 32 characters for subtitles (pairs of lines shown together), 1 to 4 words for highlight), `toSrt(lines: CaptionLine[]): string` (subtitles look, `HH:MM:SS,mmm`, CRLF line ends).

- [ ] **Step 1: Write failing tests:** `words inside a cut are gone`; `override text replaces the word`; `hidden word is skipped`; `times are output times after a cut`; `breaks at a sentence end`; `no subtitle line over 32 characters`; `highlight lines have 1 to 4 words`; `srt numbering and timestamps`; `empty transcript gives empty srt`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit:** `feat(autoedit): caption lines and SRT`

### Task 9: Captions in the compositor, preview and export

**Where:** anywhere for preview and the compositor tests; the export file check on Windows.

**Files:**
- Modify: `docs/design/avant-garde/DESIGN-SYSTEM.md` (both caption looks: font sizes per preset, band, placement, highlight colour accent, the "Burn captions" toggle in the export preset picker)
- Create: `packages/compositor/src/captions.ts`, `packages/compositor/src/captions.test.ts`
- Modify: `packages/compositor/src/index.ts`, `apps/desktop/src/components/Preview.tsx`, `apps/desktop/src/export/presets.ts`, `apps/desktop/src/export/exportVideo.ts`, `apps/desktop/src/export/exportUi.ts`, `apps/desktop/src/export/ExportStatus.tsx`, `apps/desktop/src-tauri/src/export.rs` (write `<name>.srt` beside the MP4, same `.part` then rename rule)

**Interfaces:**
- Produces: `captionLayout(lines: CaptionLine[], tOutUs: number, look: CaptionLook, out: { width: number; height: number }, frameRect: Rect): CaptionDraw | null` (pure: which words, their boxes, which word is lit) and `drawCaptions(ctx, draw: CaptionDraw): void`. `ExportPreset` gains `captionLook: CaptionLook` (`youtube`: subtitles, `vertical`: highlight) and `burnCaptionsDefault: boolean` (`youtube`: false, `vertical`: true). Preview shows the look of the preset last picked (default YouTube).

- [ ] **Step 1:** Write the caption looks into `DESIGN-SYSTEM.md` first.
- [ ] **Step 2: Write failing tests:** `no caption between lines`; `highlight lights the current word`; `subtitles sit inside the 16:9 frame bottom`; `vertical highlight sits in the ink area under the frame`; `layout is the same for preview and export sizes after scaling`.
- [ ] **Step 3:** Run, expect FAIL. **Step 4:** Implement; preview and export both call `captionLayout` + `drawCaptions` after `drawFrame`.
- [ ] **Step 5:** Run `pnpm test && pnpm typecheck && pnpm design:check`. Expected: PASS. Screenshot the preview with captions in both looks.
- [ ] **Step 6 (Windows):** Export the sample with each preset: burned captions visible in the MP4 at the same place as the preview (compare one frame), `.srt` written beside it and opens in a player.
- [ ] **Step 7: Commit:** `feat(captions): draw captions in preview and export, write SRT`

### Task 10: Captions lane and fixing a word

**Where:** anywhere.

**Files:**
- Modify: `docs/design/avant-garde/DESIGN-SYSTEM.md` (Captions lane becomes real: word blocks, selected word; caption word inspector), `apps/desktop/src/components/Lanes.tsx`, `apps/desktop/src/components/Inspector.tsx`, `apps/desktop/src/state/editorStore.ts`, `apps/desktop/src/state/actions.ts`, `packages/timeline/src/commands.ts`

**Interfaces:**
- Produces: commands `setCaptionText(wordId: string, text: string | null): Command` (null removes the override) and `setCaptionHidden(wordId: string, hidden: boolean): Command`; selection kind `{ kind: "word"; id: string }`.

- [ ] **Step 1:** Write the lane and inspector into `DESIGN-SYSTEM.md` first.
- [ ] **Step 2: Write failing tests** in `packages/timeline`: `caption override is one undo step`; `clearing the text removes the override`; `hide and unhide a word`.
- [ ] **Step 3:** Run, expect FAIL. **Step 4:** Implement the commands, the lane and the inspector.
- [ ] **Step 5:** Run `pnpm test && pnpm typecheck && pnpm design:check`; Edge screenshots of the lane and a selected word at both sizes.
- [ ] **Step 6: Commit:** `feat(editor): captions lane and caption word fixes`

---

## Part E: AI and transcription

### Task 11: Provider interface, prompt, validator, FakeProvider

**Where:** anywhere.

**Files:**
- Create: `packages/autoedit/src/ai/types.ts` (filled in), `src/ai/prompt.ts`, `src/ai/schema.ts`, `src/ai/validate.ts`, `src/ai/chunks.ts`, `src/ai/fake.ts`, `src/ai/*.test.ts`

**Interfaces:**
- Produces:
  - `type AiResult = { mistakes: Array<{ fromWordId: string; toWordId: string; why: string }>; contextFillers: string[]; zooms: Array<{ candidateId: string; fromWordId: string; toWordId: string }> }`.
  - `type EditPassInput = { words: Word[]; sections: Section[]; ruleCuts: CutSpan[]; candidates: ZoomCandidate[] }`.
  - `interface AiProvider { name: string; model: string; editPass(input: EditPassInput, signal: AbortSignal): Promise<AiResult> }`.
  - `RESULT_SCHEMA` (JSON Schema object of `AiResult`), `buildPrompt(input: EditPassInput): string` (words as `id|start ms|text` lines, sections, rule cuts, candidates; instructions: keep the last good try of a repeated or restarted sentence, mark `é`/`tipo`/`né`/`like`/`so`/`então` only when they carry no meaning, pick zooms only where speech refers to what is on screen).
  - `validateResult(raw: unknown, input: EditPassInput): AiResult | { refused: string }` (drops unknown ids, reversed ranges, overlaps; refuses when cut words exceed 50% of all words).
  - `chunkInput(input: EditPassInput, durationUs: number): EditPassInput[]` (single chunk up to 30 min; else 20 min with 30 s overlap) and `mergeResults(results: AiResult[]): AiResult` (dedupes identical or overlapping ranges).
  - `class FakeProvider implements AiProvider` returning a fixture result for the sample (cuts the restarted sentence, marks one `tipo`, picks one candidate).

- [ ] **Step 1: Write failing tests:** `prompt contains every word id and no file paths`; `schema matches the AiResult type` (a fixture validates); `validator drops unknown ids`; `validator drops reversed and overlapping ranges`; `refuses a result that cuts most words`; `chunks over 30 minutes and dedupes the overlap`; `fake provider result validates against the sample`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit:** `feat(autoedit): AI provider interface, prompt, validator, fake provider`

### Task 12: ClaudeCodeProvider (Rust sidecar)

**Where:** argument building and output parsing anywhere (`cargo test`); the real call on Windows.

**Files:**
- Create: `apps/desktop/src-tauri/src/ai.rs`, `apps/desktop/src/ai/claudeCodeProvider.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register commands), `apps/desktop/src-tauri/capabilities/default.json` if the command needs it

**Interfaces:**
- Produces: Tauri command `ai_edit_pass(prompt: String, schema: String, model: String) -> Result<String, AiError>` returning the structured result JSON as text; `ai_cancel()` kills the running child. `enum AiError { NotInstalled, NotSignedIn, UsageLimit, Failed(String), Cancelled }` serialized as `{ kind, detail }`. Rust fns `find_claude() -> Option<PathBuf>`, `claude_args(schema_path: &Path, model: &str) -> Vec<String>`, `parse_claude_output(stdout: &str, stderr: &str, code: i32) -> Result<String, AiError>`. TS `ClaudeCodeProvider implements AiProvider` (calls `invoke`, maps `AiError` to the failure sentences in the spec).

- [ ] **Step 1: Write failing tests (Rust):** `args have no tools and no session`; `parses structured_output from json mode`; `not logged in maps to NotSignedIn` (fixture stderr captured in Task 1); `usage limit maps to UsageLimit`; `missing binary maps to NotInstalled`.
- [ ] **Step 2:** Run `cargo test -p marz-desktop ai`. Expected: FAIL. **Step 3:** Implement: write the schema to a temp file, spawn in an empty temp dir, prompt on stdin, 5 min timeout, kill on cancel. **Step 4:** Run, expect PASS.
- [ ] **Step 5 (Windows):** From the app's dev console, run the provider on the Task 1 transcript of one take. Expected: a validated `AiResult` with the restarted sentence in `mistakes`.
- [ ] **Step 6: Commit:** `feat(desktop): Claude Code provider through the installed CLI`

### Task 13: Transcription (`crates/transcribe`)

**Where:** section splitting, Whisper JSON parsing and transcript writing anywhere (`cargo test`); the sidecar run and model download on Windows.

**Files:**
- Create: `crates/transcribe/Cargo.toml` (deps `serde`, `serde_json` only), `crates/transcribe/src/lib.rs`, `src/sections.rs`, `src/whisper.rs`, `src/transcript.rs`, `src/models.rs`, tests inline and `crates/transcribe/tests/fixtures/` (Whisper JSON captured in Task 1)
- Modify: root `Cargo.toml` (member), `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs`, create `apps/desktop/src-tauri/src/transcribe.rs`

**Interfaces:**
- Produces:
  - Rust: `split_sections(levels: &[f32], step_us: i64, min_pause_us: i64, min_len_us: i64, max_len_us: i64) -> Vec<(i64, i64)>`; `whisper_args(model: &Path, wav: &Path, language: Option<&str>, prompt: &str) -> Vec<String>`; `parse_whisper_json(json: &str, section_start_us: i64, mic_offset_us: i64, id_start: usize) -> (String /*language*/, Vec<Word>)`; `write_transcript(dir: &Path, t: &Transcript) -> io::Result<()>` (writes `transcript.json.tmp` then renames); `transcript_is_current(dir: &Path) -> bool` (mic bytes and modified time match).
  - Tauri commands: `transcribe(project_dir: String) -> Result<(), TranscribeError>` emitting `transcribe://progress` events `{ pct }`; `model_status() -> { present: bool, name: String, bytes: u64 }`; `download_model() -> Result<(), TranscribeError>` (only called after the user confirms in the UI). `enum TranscribeError { NoWhisper, NoModel, NoMic, Failed(String), Cancelled }`.
  - FFmpeg (existing `find_ffmpeg`) writes the 16 kHz copy to the OS temp folder; deleted afterwards.

- [ ] **Step 1: Write failing tests:** `splits at pauses over 1 s`; `never makes a section over max length`; `parses whisper word json and adds offsets`; `word ids continue across sections`; `writes atomically`; `transcript is current only when mic matches`; `no mic track skips transcription` (returns `NoMic`, writes nothing).
- [ ] **Step 2:** Run `cargo test -p marz-transcribe`, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5 (Windows):** Transcribe the three Task 1 takes through the command. Expected: `transcript.json` parses with `parseTranscript`, the switching take has sections in both languages, and the speed matches the spike within 20%.
- [ ] **Step 6: Commit:** `feat(transcribe): whisper.cpp sidecar with per-section language`

---

## Part F: Wiring (Windows for the end-to-end)

### Task 14: The AI pass in the editor

**Where:** anywhere with `FakeProvider` and the sample transcript; Windows for the real run after Stop.

**Files:**
- Modify: `docs/design/avant-garde/DESIGN-SYSTEM.md` (status line texts, "Edit with AI" ledger row with its hotkey, the AI inspector panel, the model download confirm, failure sentences on the Warning bar), `apps/desktop/src/components/Toolbar.tsx`, `apps/desktop/src/components/Inspector.tsx`, `apps/desktop/src/components/WarningBar.tsx`, `apps/desktop/src/App.tsx`, `apps/desktop/src/state/actions.ts`, `apps/desktop/src/state/editorStore.ts`, `apps/desktop/src/recorder/recorderApi.ts` (open the editor with `?ai=1` after Stop)
- Create: `apps/desktop/src/ai/runAiPass.ts`, `apps/desktop/src/ai/runAiPass.test.ts`, `apps/desktop/src/ai/pickProvider.ts`, `apps/desktop/src/ai/transcribeApi.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `runAiPass(deps: { storage: ProjectStorage; provider: AiProvider | null; transcribe: (() => Promise<void>) | null; history: History; onStatus: (s: AiStatus) => void; signal: AbortSignal }): Promise<AiOutcome>`; `type AiStatus = { step: "transcribing"; pct: number } | { step: "editing" } | { step: "done"; cuts: number; zooms: number; captions: boolean } | { step: "nothing" }`; `type AiOutcome = { warnings: string[] }`. `pickProvider()` gives `ClaudeCodeProvider` in Tauri, `FakeProvider` in the browser dev path.
- Status copy (exact): "Transcribing 40%", "Editing with AI", "AI edit: 23 cuts, 6 zooms, captions. Ctrl+Z undoes it", "No speech found. Nothing was cut.". Failure sentences (exact, Warning bar): "Whisper is missing. Install it or set MARZ_WHISPER. Only silences were cut.", "Claude Code is not installed. Mistakes and AI zooms were skipped.", "Claude Code is not signed in. Open it once and sign in.", "Claude usage limit reached. Rerun later.", "AI result looked wrong. Mistakes and AI zooms were skipped.".

- [ ] **Step 1:** Write all of the UI above into `DESIGN-SYSTEM.md` first; pick the "Edit with AI" hotkey there (must not clash with Space, Z, C, A, Del, Ctrl+Z, Ctrl+Shift+Z, Ctrl+E).
- [ ] **Step 2: Write failing tests** (`runAiPass.test.ts`, fake deps): `runs transcribe, rules, ai, apply in order`; `skips transcription when transcript is current`; `provider failure still applies rule cuts and captions and warns`; `transcription failure cuts silences from levels only and warns`; `closing the project aborts the pass` (abort signal: no `History.apply`, no write); `edits during the run win` (end to end with `touchedRanges`); `no speech gives the nothing status`.
- [ ] **Step 3:** Run, expect FAIL. **Step 4:** Implement `runAiPass`, the ledger row, the inspector panel (pace slider re-applies through `setAiPace` without calling the provider; kind toggles through `setAiKinds`), the status line, and the model download confirm ("Download the transcription model (550 MB)?" with Download / Not now).
- [ ] **Step 5:** Run `pnpm test && pnpm typecheck && pnpm design:check`; in Edge against the sample with `FakeProvider`: open `?project=demo&ai=1`, see the status line steps, the AI edits, Ctrl+Z restores the raw project, the slider changes cut lengths. Screenshots at 1440 x 900 and 1280 x 720.
- [ ] **Step 6: Commit:** `feat(editor): run the AI pass after recording and on demand`

### Task 15: End to end on Windows, quality check, docs

**Where:** Windows.

**Files:**
- Modify: `docs/superpowers/specs/2026-11-15-milestone-1-design.md` (format contract: `transcript.json`, new fields, tolerant readers), `docs/superpowers/specs/2026-11-17-milestone-2-ai-editing-design.md` (status), `CLAUDE.md` (status, M2 run notes), `docs/LEARNINGS.md`

- [ ] **Step 1:** Record a fresh take with the app, press Stop. Expected: editor opens, status goes Transcribing, Editing with AI, done; edits marked AI; captions in the lane. Export both presets; burned captions and `.srt` present.
- [ ] **Step 2:** Run the pass on Mauricio's three Task 1 takes. Pass criteria from the spec: every deliberate mistake found, no meaningful word cut, publishable after at most two manual fixes per take. Mauricio judges the last one; ask him to watch the three exports.
- [ ] **Step 3:** Failure runs: rename the Whisper binary (expect the Whisper sentence, silences still cut), run with Claude Code signed out (expect its sentence, rule cuts and captions still there).
- [ ] **Step 4:** Update the docs listed above; add learnings.
- [ ] **Step 5: Commit:** `docs: M2 format contract, status and learnings`

---

## Build order and parallel work

Task 1 first on Windows (its numbers and fixtures feed Tasks 4, 12, 13). Tasks 2 to 11 can run in the cloud in order 2, 3, 4, 5, 6, then 7, 8 to 10 and 11 in any order. Tasks 12 and 13 need Windows for their last step. Task 14 after 6, 10, 11; Task 15 last.
