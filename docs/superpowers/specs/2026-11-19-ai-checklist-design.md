# AI checklist: design

Date: 2026-11-19. Product spec section 10 ("AI checklist overlay"). Owner pre-approved building straight through.

## What it does

1. Before recording he types the topics he wants to cover, one per line, in a Checklist panel on the setup bar.
2. While recording, a small panel on the overlay lists them. The overlay is capture-excluded, so the panel is never in the video.
3. A topic ticks by itself when he talks about it: the mic is transcribed locally in short rolling chunks and the text is matched against each topic.
4. He can tick the next open topic by hand with Ctrl+Shift+K.
5. Every tick is a `checklist` line in `events.jsonl`.
6. In the editor a Checklist tab lists the topics with the time each was covered; a click jumps there. Topics not covered are flagged: the tab opens by itself after Stop when one is open, and each open row says "Not covered".

Only text goes to the AI. Audio never leaves the PC.

## Live transcription (Rust, `src-tauri/src/checklist.rs` + `crates/transcribe/src/live.rs`)

- Source: the growing `mic.wav` the engine is writing (48 kHz mono s16). The mic writer is not touched: a separate thread opens the file read-only (Rust opens files with shared read and write on Windows) and reads the bytes past what it already read. File sample `n` is recording time `mic_first_rec_us + n / 48000 s` (the mic timeline drops samples while paused and writes silence while muted, so this holds).
- Cadence: one chunk when at least 6 s of new audio is there; each chunk also takes the last 1 s before it (words cut at the edge), at most 30 s per chunk.
- Gate: a chunk whose peak is below -45 dBFS is skipped (silence, mute): no Whisper run, no invented words.
- Whisper: the same `whisper-cli` and model as the AI pass (`find_whisper`, `models`), one word per segment, VAD on, the topic texts as `--prompt` (helps Whisper spell his own terms). Input is a 16 kHz copy in a temp folder (3-sample average from 48 kHz). The process runs at below-normal priority so the capture threads win.
- Words come back in recording time; words that start before the last kept word ended minus 50 ms are duplicates from the overlap and are dropped (`append_words`).
- Words go to the overlay page as `checklist://words`; the page matches them (below).
- No mic, or Whisper or the model missing: no live transcription. The overlay panel says so in its last line and Ctrl+Shift+K still works.
- Test hook: `MARZ_CHECKLIST_FEED=<file.wav>` makes the thread read that WAV (any PCM 16-bit mono 48 kHz file) instead of `mic.wav`, released at recording speed. Used for the owner-less check; it does not prove the real mic path.

## Matching (TypeScript, `packages/autoedit/src/checklist.ts`)

Cheap and local first:

- Normalize: lower case, accents removed, punctuation to spaces. English and Portuguese stop words dropped. A topic's keywords are its remaining distinct words (all words if none remain).
- Two words match when equal, when both are 4+ letters and share a stem (one starts with the other's first `max(4, shorter - 2)` letters: "pricing" and "price", "export" and "exporting"), or by edit distance (1 for 5 to 7 letters, 2 for 8+).
- A topic is covered when, inside any 30 s of transcript, at least `max(1, ceil(0.6 x keywords))` of its keywords were said. The covered time is the first matched word in that window.

Escalation to Claude Code (the existing provider, `claude -p` on his subscription, model haiku, no tools):

- Only when open topics remain, at least 15 new words came in since the last ask, the last ask was 60 s ago or more, none is running, and fewer than 20 asks were made this recording.
- Sends the open topics and the transcript since 10 s before the last ask (max 3 min), as text with times in seconds. Answer schema: `{ "covered": [{ "id": "c2", "atSec": 41.2 }] }`, checked against the open ids and the sent window.
- Claude missing, not signed in, or at its limit: no more asks this recording. Failures never stop the recording or the local matching.

## Recorder

- Setup bar: a "Checklist" button after Hide cursor (`list` icon, label, count when topics exist). It opens the Checklist panel on top of the bar: a text area, one topic per line, at most 12 topics of 120 characters. Saved with the setup (localStorage), so the list comes back.
- `start_recording` gets `checklist: string[]` (optional, older pages send none). Rust trims, drops empty lines, keeps 12, gives ids `c1`..`c12`.
- Overlay panel while recording (top right, see DESIGN-SYSTEM.md "Recorder: checklist"): the topics, ticked ones with their time; clicks pass through.
- Hotkey Ctrl+Shift+K (registered with the other recorder keys, id 19): ticks the first open topic, by hand, at the current recording time. Free in the recorder set; in other apps Ctrl+Shift+K is rare (Firefox console, VS Code delete line) and the key is held only while the recorder is open.
- `RecState` gains `checklist: [{ id, text, atUs, by }]` and `checklistNote` (null, or why ticking is by hand only).

## `events.jsonl` (format version stays 1)

```
{"tUs":0,"type":"checklist","op":"list","items":[{"id":"c1","text":"Pricing page"},{"id":"c2","text":"Refunds"}]}
{"tUs":41890000,"type":"checklist","op":"tick","id":"c1","atUs":38120000,"by":"auto"}
```

- `list`: written once, right after the recording starts, when the list is not empty.
- `tick`: `tUs` is when it was logged, `atUs` when the topic was said (recording time), `by` is `auto` (local match), `ai` (Claude) or `hand` (Ctrl+Shift+K). One tick per topic.
- Older readers ignore the unknown type (as they do today).

## `project.json` (optional field, format version stays 1)

`edits.checklist` (passthrough, optional):

```json
{ "items": [{ "id": "c1", "text": "Pricing page", "atUs": 38120000, "by": "auto" },
            { "id": "c2", "text": "Refunds", "atUs": null }],
  "liveImported": true }
```

- Imported from the `checklist` lines the first time the take opens (like live layouts and drawings).
- `by` adds `transcript` (found in the full transcript after the AI pass) and `editor` (marked in the editor).
- Missing means the recording has no checklist. Items this build cannot read are dropped from the panel, not from the file.

## Editor

- A Checklist tab in the inspector (only when the project has a checklist), hotkey K. Rows: square (ticked or open), topic text, the time ("01:12.4") and how it was ticked; open rows show "Not covered". A click on a covered row jumps there. "Mark here" on an open row covers it at the playhead (one undo step); "Clear" on a covered row opens it again (one undo step).
- After Stop: the first open of a take with open topics shows the Checklist tab.
- The AI pass (after Stop, or Shift+E) also matches the open topics against the whole transcript with the same matcher (`by: "transcript"`), inside the AI edit's undo step. The full transcript is better than the live chunks, so a topic the live pass missed can still be found.

## Not in this version

Reordering or editing topics in the editor, more than 12 topics, ticking a chosen topic by hand while recording (the hotkey ticks the next open one), timeline markers for topics.
