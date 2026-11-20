# Keypress log and on-video keys: design

Date: 2026-11-19. Product spec section 3 ("keypresses (optional)"). Owner pre-approved building it straight
through. Scope: an opt-in log of shortcuts while recording, and keycap labels drawn on the video in preview and
both exports. Not in scope: a live keys overlay on screen while recording, mouse wheel, logging typed text (never).

## Privacy (the rule everything else follows)

- Off by default. One switch, "Log shortcuts", on the recorder setup bar and in Settings (Devices). Both read and
  write the same remembered default, like Computer sound.
- Off: the keyboard hook is not even installed.
- On, the engine writes a line ONLY for:
  - a key pressed while Ctrl, Alt or Win is held (Ctrl+S, Alt+Tab, Win+Shift+S, Ctrl+Shift+P);
  - a named key pressed while only Shift is held (Shift+Tab, Shift+Enter, Shift+F5, Shift+arrows); Shift plus a
    letter, digit, symbol or Space is typing and is never written;
  - a named key on its own: Enter, Esc, Tab, Delete, Insert, Home, End, Page Up, Page Down, the four arrows,
    F1 to F24, Print Screen. Not Space, not Backspace (both are typing).
- Never written:
  - plain letters, digits, symbols, Space, Backspace (typed text);
  - anything while Right Alt (AltGr) is held without Win: AltGr types characters such as @ on many layouts
    (Windows sends it as Ctrl+Alt);
  - the recorder's own hotkeys (Ctrl+Shift+R, Ctrl+1, ...), in whatever combo Settings bound them to;
  - anything while a password field has the keyboard focus. Checked two ways: a classic Windows edit box with the
    password style, and UI Automation's "is password" on the focused element (browsers, modern apps). If the check
    itself fails, the key is NOT written (fail closed).
- Held keys: one line per press, auto-repeat is ignored.
- The setup bar and Settings say it in plain words: "Logs shortcuts like Ctrl+S and keys like Enter or Esc, to
  show them on the video. Never letters you type, never in password fields."

## Recording (capture engine)

New line type in `events.jsonl` (older builds ignore unknown types):

```
{"tUs":1250000,"type":"key","keys":["Ctrl","Shift","S"]}
```

- `keys`: the held modifiers in the fixed order `Ctrl`, `Alt`, `Shift`, `Win`, then the pressed key's name.
- Key names: `A`..`Z`, `0`..`9`, `F1`..`F24`, `Enter`, `Esc`, `Tab`, `Space`, `Backspace`, `Delete`, `Insert`,
  `Home`, `End`, `PageUp`, `PageDown`, `Up`, `Down`, `Left`, `Right`, `PrintScreen`, `Num0`..`Num9`, `Num*`, `Num+`,
  `Num-`, `Num.`, `Num/`, and for symbol keys the character the key types without Shift on the current layout
  (`/`, `;`, `[`, `-`, `=`, `,`, `.`). A key with no name (media keys, unknown keys) is not written.
- Written by a low-level keyboard hook on the existing input thread (the mouse hook's thread). The hook only reads
  the key and queues it; the password check and the write run on the same thread right after the hook returns, with
  the press time taken in the hook. Keys sent by other programs (SendInput) are treated like real ones.
- `RecordOptions.log_keys`, CLI flag `--log-keys`, recorder page option `logKeys` (missing: off).

## Project format (optional, version stays 1)

Key lines become blocks the first time the take opens (like live drawing strokes), so they can be hidden and
retimed without touching `events.jsonl`:

```json
"edits": {
  "keys": {
    "show": true,
    "position": "bottomLeft",
    "size": "M",
    "style": "ink",
    "items": [{ "id": "key-1", "startUs": 1250000, "endUs": 2750000, "keys": ["Ctrl", "S"], "count": 1, "hidden": false }],
    "liveImported": true
  }
}
```

- Import: each press shows for 1.5 s. The same combo pressed again while it shows adds to `count` (drawn "x3") and
  extends the block to 1.5 s after the last press. A different combo ends the block before it at its press.
  Blocks never overlap. A block shorter than 0.1 s is dropped. Ends are clamped to the take.
- `show`: whole video on or off (default on). `hidden` on a block hides that block only.
- `position`: `bottomLeft` (default), `bottomCenter`, `bottomRight`, `topLeft`, `topCenter`, `topRight`.
- `size`: `S`, `M` (default), `L`. `style`: `ink` (default), `paper`, `accent`.
- Unknown values read as the default and are kept on save; blocks this build cannot read are kept as they are.
- A take without `key` lines gets no `edits.keys` and nothing changes.

## Drawing (compositor, same code in preview and export)

- Video content in output space, on top of everything (after the camera and captions). Zooms and layouts never
  move it.
- Look (Editorial Brutalism, tokens only): a plate in the style tone with square corners; inside it one keycap per
  key, a square box with a 2px outline in the text tone (scaled), the key name in Martian Mono 500 uppercase in the
  text tone, a "+" in the text tone between caps, then "x3" when `count` > 1. No radius, no shadow, no blur, no
  gradient, no fade (on at the press, off at the end).
  - Ink: ink plate, paper caps outline and text. Paper: paper plate, ink. Accent: accent plate, ink.
- Labels: `Ctrl`, `Alt`, `Shift`, `Win`, `Enter`, `Esc`, `Tab`, `Del`, `Ins`, `Home`, `End`, `PgUp`, `PgDn`, the
  arrows as `Up`, `Down`, `Left`, `Right`, `PrtSc`, `Space`, `Bksp`; others as named.
- Size: cap text height 2.8% of the output height in landscape (S 0.8, M 1, L 1.25), 4.2% of the output width
  in the vertical export. Gap to the frame edges 4% of the output height (landscape).
- Vertical export (both framings): inside the Reels/TikTok safe area (`SAFE_AREA`), the same six positions in it.
- Preview draws exactly what the export draws (the 16:9 preview and the vertical preview).

## Editor

- Keys lane (lanes view, a Later lane after Captions): real when the take has key blocks. One block per combo:
  label "Ctrl+S" (plus " x3"), the Layout lane's block geometry, paper fill, ink label; a hidden block has the
  `later` dashed border and no fill. Main track: the same blocks on the Edits track.
- Drag, trim (kept between its neighbours, at least 0.1 s), snap, select; Del deletes the block. Each change is one
  undo step. No new tool in the ledger and no new hotkey: blocks come from the recording.
- Keys block selected: title "Keys", subtitle the combo, Start and End cells, toggle "Show these keys", Length,
  note "Logged while recording. Hide it here, or move it on the timeline.", button "Delete block".
- Project panel "Keys" section (only when the take has key blocks): toggle "Show keys on the video", Position
  (two rows: Top / Bottom and Left / Centre / Right), Size S / M / L, Style Ink / Paper / Accent (swatches).

## Tests

Format: parse the `key` line (unknown names kept as text, empty lists dropped), `keysEdits` reading and defaults.
Timeline: import (hold, repeats counted, replace, min length, clamp, once only), update (no overlap, min length),
remove, setKeys. Compositor: block at a time, hidden, show off, layout per position and size in landscape and
vertical, labels. Capture (Rust unit tests): the privacy filter (every rule above, AltGr, recorder hotkeys), key
names, `key` line format. Real take on Windows with simulated combos, frames checked in preview and both exports.
