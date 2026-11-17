# Marz Recorder: Milestone 2 Design (AI editing)

**Status:** APPROVED by Mauricio on 2026-11-17, with the review calls marked "Claude's call". Dependencies: Whisper approved; Claude runs through his own Claude Code subscription, no API key (his call, 2026-11-17).
**Date:** 2026-11-17
**Builds on:** Milestone 1 (branch `claude/capture-plan-d523b6`, PR 1). M2 work branches from that branch (or from main once PR 1 is merged); steps 2 to 4 can start in the cloud right away: capture engine, Tauri shell, Home, recorder bars, editor, export. M1 design and format contract: `docs/superpowers/specs/2026-11-15-milestone-1-design.md`. Product spec: `docs/product-spec.md` (sections 2, 9, 10, 12).

## Intent

After M1, every recording still needs a manual edit pass: finding silences, ums and restarted sentences, placing zooms. Mauricio wants to stop doing that work:

> Record, stop, and the editor opens with the video already edited by AI (cuts, zooms, captions). He only reviews and exports.

Why now: M1 made recording and editing possible; the editing time is what is left between a recording and a published video.

## Goals

- **Transcribe locally** after every recording: word-level timestamps, pt-BR and English, and he switches language mid-video, so the language is detected per section, not once per file.
- **Cut silences and ums by rules** from the transcript and the mic audio. Free, offline, exact.
- **Cut mistakes with AI:** when he restarts a sentence or repeats a take, keep the last good try and cut the rest.
- **Place zooms with AI:** Claude reads what he says plus where he clicked and picks which click clusters to zoom on and for how long.
- **Captions:** word-level captions from the transcript, editable, drawn in the preview and burned into the export. Two looks, picked per export: word-by-word highlight (vertical preset) and classic two-line subtitles (YouTube preset). An `.srt` file is written next to the MP4.
- **Already applied:** the editor opens with all AI edits in place, marked as AI on the timeline. Each one can be tweaked or deleted; the whole AI pass is one undo step.
- **Runs automatically after Stop**, in the background while the editor opens. A button reruns it any time.
- **Pace slider:** natural by default (about 0.3 s of breath kept around each cut); one slider makes cuts tighter or looser and re-applies them.

All of the above were picked by Mauricio on 2026-11-17.

## Non-goals for M2

AI checklist overlay, live transcript while recording, noise cancelling, loudness normalization, auto-reframe to 9:16 (vertical stays letterboxed), camera, system audio, translating captions, caption styles beyond the two, chat with the AI ("make it shorter"), local LLM provider (the interface allows it; only Claude ships).

## Anti-goals

- **Raw tracks are never modified.** Transcription reads `mic.wav` through a temporary 16 kHz copy outside the project folder.
- **Never send video or audio to the AI.** Only transcript text, word timings and a numeric summary of input events leave the PC.
- **The AI never invents screen coordinates.** Zoom rects come only from click clusters the rules already found; the AI picks among them.
- **Never clobber his work.** A rerun replaces only AI edits he has not touched; anything he edited, added or kept stays.
- **No silent failure.** If transcription or the AI step fails, he sees one plain sentence and the rest of the pass still applies.
- **Preview and export must not differ.** Captions are drawn by the same compositor in both.

## Constraints

- Windows 11, local machine with an NVIDIA GPU (NVENC was used in M1).
- The editor keeps running in a plain browser against `samples/demo.marz`, so cloud sessions can build and test everything except the Whisper and Claude calls. Those two sit behind interfaces with fake implementations for the browser path.
- `DESIGN-SYSTEM.md` is binding. The Captions lane is currently a dashed "Later" lane, and rule 12 forbids captions and AI panels: M2 lifts that rule for captions and the AI pass, and every new piece of UI is written into `DESIGN-SYSTEM.md` in its style before it is built.
- New dependencies and every `project.marz` change need Mauricio's yes (listed below).

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A** | **Rules for exact work, Claude only for judgment** | Silences and ums cut by rules from word timings (free, offline, frame-exact). Claude decides mistakes and zooms. Cheapest; half the pass works with no internet or no Claude. **Chosen.** |
| B | Everything through Claude | Simplest code, but costs more per video, and model-chosen timings are less exact than rule timings. |
| C | Fully local (rules + local model) | No cost, but mistake and zoom picks get noticeably worse; heavy model download. |

**Chosen: A**, picked by Mauricio on 2026-11-17.

## How it works

### The AI pass

Runs after Stop (automatic) or from the "Edit with AI" tool (rerun). Steps, each reported in the status line:

1. **Transcribe** (Windows, Rust): FFmpeg writes a 16 kHz mono copy of `mic.wav` to a temp folder. It is split into sections at pauses (about 30 s to 2 min each); Whisper detects the language of each section and transcribes it in that language with word timestamps. Result goes to `transcript.json` in the project, in source time (`mic.offsetUs` added). Skipped when `transcript.json` already exists for the same `mic.wav` (size and modified time match), so a rerun does not transcribe again.
2. **Rules** (TypeScript, `packages/autoedit`, runs anywhere):
   - **Silences:** gaps between words longer than 0.8 s where the mic level also stays low are cut, leaving the pace padding on each side.
   - **Pure fillers:** one word list for both languages (`um`, `uh`, `erm`, `hmm`, `ã`, `hum`, `ahn`, and stretched forms like `éé`) is cut word by word with padding. A short `é` is also the verb "is" in Portuguese, so only a stretched `é` (held over about 0.4 s, alone between pauses) counts as a pure filler; any other `é` goes to Claude as a context filler.
   - **Click clusters:** the M1 auto zoom code produces zoom candidates (id, time span, rect). Today these become zooms directly; in M2 they are candidates for step 3.
3. **AI** (Claude through the provider interface): receives the words (with ids and times), the cuts already made by rules, and the zoom candidates. Returns structured JSON:
   - `mistakes`: word ranges to cut, each with a short reason ("restarted sentence", "repeated take").
   - `contextFillers`: words like `tipo`, `né`, `like`, `you know` that are filler here (not meaningful), to cut.
   - `zooms`: candidate ids to use, each with start and end word ids (the zoom spans what he is saying about that spot).
   The response is validated; anything that does not reference real ids is dropped.
4. **Apply:** one editor command builds the full set of AI edits and replaces the previous AI edits in one undo step (see "Rerun rules").

If step 1 fails (no Whisper, no model): rules for silence still run on the audio level alone, captions and filler cuts are skipped, and the warning bar says so. If step 3 fails (Claude Code missing or signed out, offline, usage limit): rule cuts and captions still apply; mistakes and AI zooms are skipped; the warning bar says so and the rerun button tries again. The M1 click-based auto zoom (A) keeps working as today.

### Rerun rules

- Every AI edit carries `origin: "ai"`. When he moves, trims or retimes one, it becomes `origin: "manual"` and a rerun never touches it.
- Deleting an AI edit records it in `edits.ai.rejected` by what it covers, not by time (cut: reason + first and last word id, or for a silence the word ids on both sides; zoom: candidate id), so the pace slider and a rerun cannot bring it back. (Claude's call, from the review.)
- A rerun removes the remaining `origin: "ai"` edits and adds the new ones, as one undo step. Ctrl+Z after a run restores exactly the state before it.
- **Editing during a run** (Claude's call): the pass works on a snapshot taken when it starts. When it finishes, it lands as one new undo step on top of whatever he did meanwhile. An AI cut or zoom that overlaps a cut or zoom he added or changed during the run is dropped. Caption fixes and playhead moves do not count. Ctrl+Z then undoes the AI step only, his edits stay.
- **M1 auto zooms** (Claude's call): the AI pass replaces untouched `origin: "auto"` zooms (picked candidates become `"ai"`, the rest go). Pressing A later still runs the click rules, replacing only `"auto"` zooms and skipping clusters that overlap an AI, manual or live zoom. When the AI step fails, zooms are left as they were (no fallback zooms appear by themselves).
- Moving the pace slider re-applies padding to AI cuts only, without calling Claude again (the AI result is kept in memory and in `edits.ai.lastResult`).

### Captions

- Built from transcript words minus the words inside cuts, so captions follow the edit automatically.
- Grouped into lines by rules: break at sentence ends and pauses, at most about 32 characters per line, two lines for subtitles, one short line (1 to 4 words) for highlight.
- Fixing a word: select it in the Captions lane, type the new text in the inspector. Stored as an override in `project.json` (undoable), never by rewriting `transcript.json`.
- Hiding a word from captions (without cutting the audio) is an override too.
- Drawn by the compositor for the output time, so preview and export match. Look: Familjen Grotesk, paper text on an ink band (subtitles) or paper text with the current word in accent (highlight). Placement: subtitles in the bottom of the 16:9 frame; highlight in the ink area under the letterboxed frame in the vertical preset. Exact sizes are added to `DESIGN-SYSTEM.md` first.
- Export: a "Burn captions" toggle per export, on by default for vertical, off for YouTube. An `.srt` (output times, after cuts) is always written next to the MP4 when a transcript exists.

### AI provider interface

```ts
interface AiProvider {
  name: string;                       // "claude-code"
  editPass(input: EditPassInput, signal: AbortSignal): Promise<EditPassResult>;
}
```

- **`ClaudeCodeProvider` on the desktop** (Mauricio's call: use his Claude subscription, not a paid API key). Rust runs the Claude Code CLI already installed and signed in on his PC as a sidecar, found like FFmpeg (`MARZ_CLAUDE` env var, then PATH): `claude -p` with the prompt on stdin, `--output-format json`, `--json-schema` for the result shape, `--tools ""` (no tools at all), `--no-session-persistence`, `--strict-mcp-config`, no setting sources, model `sonnet` (a setting), started in an empty temp folder. Only the prompt text goes in; nothing on disk is reachable. Checked on 2026-11-17: his installed Claude Code has all of these flags.
- Usage counts against his plan's limits instead of costing money. A 10-minute video is about 1,500 to 2,000 spoken words, a small request. Recordings over 30 minutes are sent in chunks of about 20 minutes with 30 s overlap (Claude's call).
- `FakeProvider` in the browser and tests: returns a fixture result for the sample project.
- Failure sentences: "Claude Code is not installed. Mistakes and AI zooms were skipped.", "Claude Code is not signed in. Open it once and sign in.", "Claude usage limit reached. Rerun later.".
- Going public later: other users would need their own Claude Code, or an API-key provider added behind the same interface. Parked, not in M2.

### Transcription engine

- `whisper.cpp` command-line binary as a sidecar program, found like FFmpeg (`MARZ_WHISPER` env var, beside the exe, then PATH). Same pattern as FFmpeg in M1, no native build in our crate.
- Model: `large-v3-turbo` (quantized, about 550 MB) on the GPU build; it is much better in Portuguese than the small models. Fallback when no GPU build works: `small` on CPU. Downloaded on first use to the app data folder after he confirms the size; never stored in a project.
- A prompt seeded with fillers in both languages, because Whisper tends to drop "um"s from transcripts. **This is the main risk; the spike measures it first.**

### UI (all added to `DESIGN-SYSTEM.md` before building)

- **Status line** in the save-status slot while the pass runs: "Transcribing 40%", "Editing with AI", then "AI edit: 23 cuts, 6 zooms, captions. Ctrl+Z undoes it" (faint) until the next edit. Editing stays possible during the pass (see "Editing during a run").
- **Tool ledger:** new row "Edit with AI" with its own hotkey; runs the pass again.
- **Timeline:** AI cuts and zooms show a small "AI" tag on their cap; cut caps show the reason ("Silence", "Um", "Mistake"). The Captions lane becomes a real lane with the caption words as small blocks. Footer counts: "8 zooms / 23 cuts / 6 by AI".
- **Inspector, nothing selected:** the AI pass panel: pace slider (Tight to Loose), toggles for Silences, Ums, Mistakes, AI zooms, Captions, and the last run's languages and model.
- **Inspector, caption word selected:** text field, "Hide from captions" toggle.
- **Export:** the preset picker gets the "Burn captions" toggle.

## Format changes (`project.marz` v1, additive)

All additions are optional fields or a new file, so M1 projects stay valid and open unchanged. Each needs Mauricio's yes and goes into the M1 design doc's format contract section when built.

1. **New file `transcript.json`** (derived, regenerable, written by the transcription step only, never by the editor):
   ```json
   { "version": 1, "engine": "whisper.cpp large-v3-turbo",
     "mic": { "bytes": 11520044, "modifiedAt": "2026-11-17T19:00:00Z" },
     "sections": [ { "startUs": 0, "endUs": 48000000, "language": "pt" } ],
     "words": [ { "id": "w1", "text": "Então", "startUs": 1240000, "endUs": 1610000, "p": 0.93 } ] }
   ```
2. **Cuts get `origin`** (`"manual"` default, `"ai"`) and an optional **`reason`** (`"silence"`, `"filler"`, `"mistake"`).
3. **Zoom `origin` gets a new value `"ai"`** and an optional `candidateId`.
4. **`edits.captions`** (optional): `{ "overrides": { "w12": "Marz" }, "hidden": ["w40"] }`. Look and burn-in are export choices, not stored.
5. **`edits.ai`** (optional): `{ "paceUs": 300000, "kinds": { "silences": true, "fillers": true, "mistakes": true, "zooms": true, "captions": true }, "rejected": [...], "lastRun": { "at": "...", "provider": "claude-code", "model": "sonnet", "languages": ["pt", "en"] }, "lastResult": { ... } }`.

**Compatibility fix first:** M1's `parseProject` rejects the whole project on an unknown `origin` or `easing` value (noted in LEARNINGS "Deferred"). M2 makes readers tolerant (unknown value read as `"manual"` and preserved on save) before any new value is written.

## New dependencies

| Dependency | Where | Status |
|---|---|---|
| `whisper.cpp` CLI (MIT), external program | sidecar | Approved 2026-11-17 |
| Whisper `large-v3-turbo` model (about 550 MB) and `small` (about 470 MB), MIT | app data, downloaded on first use after he confirms | Approved 2026-11-17 |
| Claude Code CLI (already installed, his subscription) | sidecar | His call 2026-11-17; nothing new to install |

Not added: `reqwest`, `keyring`, any API key. No new npm packages.

## Testing

- Cloud and local: `packages/autoedit` unit tests (silence, filler, padding, rerun rules, captions line breaking, SRT); `FakeProvider` against `samples/demo.marz` with a fixture `transcript.json` written by `pnpm sample`; compositor caption frames compared preview vs export.
- Windows only: the Whisper sidecar, the Claude Code sidecar, the run after Stop.
- **Quality check with real takes:** Mauricio records three short takes (one pt-BR, one English, one switching language mid-take), each with deliberate ums, a restarted sentence and a repeated take. The pass passes when it finds every deliberate mistake, cuts no meaningful word, and he would publish the result after at most two manual fixes per take.

## Build order

1. **(Windows) Spike:** whisper.cpp turbo on his GPU vs `small` on CPU (speed per minute of audio, word timing accuracy against the audio, whether ums survive with the filler prompt, pt-BR and English, language detection per section on a take that switches); one `claude -p` call with the JSON schema on a real transcript to judge mistake detection, its speed and its usage cost against his plan. Results in `docs/spikes/`.
2. Format: tolerant readers, new fields and `transcript.json` schema in `packages/format`, sample transcript fixture.
3. `packages/autoedit`: silences, fillers, padding, rerun rules, one-step apply command, AI tags on the timeline.
4. Captions: line building, compositor drawing, Captions lane, word edit, export toggle, SRT.
5. AI provider interface, `FakeProvider`, Claude Code provider in Rust, mistakes, context fillers, AI zooms.
6. (Windows) Run after Stop, status line, rerun tool, failure sentences, quality check with his three takes.

Steps 2 to 4 can be built in the cloud; 1 and 6 need Windows.

## Left to the builder

Package names beyond `packages/autoedit`, prompt wording, exact thresholds (tuned in the spike), the hotkey for "Edit with AI" (picked when writing it into `DESIGN-SYSTEM.md`, no clash with existing ones), component structure, test layout.
