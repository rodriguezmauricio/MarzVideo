# Swappable AI provider (design, 2026-11-19)

Product spec sections 1 and 2: "AI features go through a swappable provider interface; default Claude,
swappable to local model or MarzOS route". This builds the interface and three providers plus Off.
The MarzOS route is a later provider on the same interface.

## What changes for Mauricio

Nothing, unless he opens Settings. The default stays Claude Code (`claude -p`, his subscription) with
the same flags, model and effort. Settings > AI gains a Provider choice, a Test connection button and a
plain sentence about what is sent.

## Providers

| Id | Name in Settings | How | Edit pass model | Checklist model |
|---|---|---|---|---|
| `claude-code` | Claude Code | `claude -p` as today (`ai.rs`, unchanged args) | Sonnet or Opus (the existing Model setting), effort high | haiku |
| `anthropic` | Anthropic API | `POST https://api.anthropic.com/v1/messages`, raw HTTP from Rust | `claude-opus-5-5` (default) or `claude-sonnet-5-5`, effort high | `claude-haiku-5-5`, effort low |
| `local` | Local | `POST <url>/v1/chat/completions` (OpenAI compatible: Ollama, LM Studio, llama.cpp server) | the model name he types | same model |
| `off` | Off | no call | rules only | local word matching only |

Both AI users go through the same Rust function `provider::ask(purpose, prompt, schema)`:
the editor's AI pass (`ai_edit_pass`) and the live checklist ask (`checklist_ai`). The prompts, the
schemas and the validator in `packages/autoedit` do not change: every provider gets the same prompt text
and must answer the same JSON.

### Anthropic API details

- Raw HTTP (Rust has no official SDK). Headers `x-api-key`, `anthropic-version: 2026-10-21`, and
  `anthropic-beta: server-side-fallback-2026-07-01` with `"fallbacks": "default"` on the Opus and Sonnet
  calls (a safety decline is re-run on a fallback model inside the same call; Haiku has no server
  fallback). No `temperature` (refused on this API version).
- Structured output: `output_config: { format: { type: "json_schema", schema }, effort }`. Thinking is
  left at the model default (adaptive). `max_tokens` 32000, non-streaming, 5 minute timeout (same as
  Claude Code). `stop_reason` `refusal` or `max_tokens` is a failure with a reason.
- Errors: 401/403 = key refused, 429 and 529 = limit reached, others = failed with the API's message.
- Test connection: `GET /v1/models/<model>`. It checks the key and the model and costs nothing.

### Local details

- The address defaults to `http://localhost:11434` (Ollama). `/v1` is added unless he typed it.
- `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }`, plus a system
  line asking for that JSON only. Code fences around the answer are stripped before parsing.
- No key. Test connection: `GET <url>/v1/models`, then checks the model name is listed.
- Small local models may not hold a whole long take in their context (Ollama's default context is
  small). The validator refuses an answer that does not fit, and the pass falls back to rules only with a
  warning, as for any other failure.

## The API key

- Stored only in Windows Credential Manager (generic credential `Marz Recorder/anthropic-api-key`, user
  scope, `CredWriteW` / `CredReadW` / `CredDeleteW` through the `windows` crate the app already uses).
  Never in `settings.json`, never in localStorage, never sent to the webview after saving, never logged.
- Settings shows only "Saved in Windows Credential Manager" and the last 4 characters.
- In Rust the key lives in a `Secret` type whose `Debug` prints `***`. Error texts are built from status
  codes and the API's error message, never from request headers.
- Other OSes (cloud test sessions): no store; saving says the key store needs Windows.

## Settings stored

`settings.json` gains one optional object (unknown keys are kept as before):

```json
"ai": { "provider": "claude-code", "anthropicModel": "claude-opus-5-5", "localUrl": "http://localhost:11434", "localModel": "llama3.1" }
```

Missing means Claude Code with the defaults. The Claude Code model stays in localStorage `marz.ai.model`.
`project.marz` is unchanged: `edits.ai.provider` and `model` already record which provider answered.

## Fail soft

- Any provider failure: the rules (silences, ums, level cuts) still apply, the last good AI answer is
  kept, and the Warning bar names the reason in one sentence:
  - Off: "AI is off in Settings. Only silences and ums were cut."
  - No key: "No Anthropic API key saved. Add it in Settings. Mistakes and AI zooms were skipped."
  - Key refused: "The Anthropic API key was refused. Check it in Settings. Mistakes and AI zooms were skipped."
  - Local not answering: "The local AI did not answer. Check its address in Settings. Mistakes and AI zooms were skipped."
  - Existing Claude Code sentences unchanged.
- The checklist stops asking for the rest of the recording on Off, no key, key refused, not installed,
  not signed in and usage limit (as today for the Claude Code ones); words still tick topics locally.

## What is sent (shown in Settings)

"Only text leaves the app: the transcript words with their times, the silence cuts, click times for
zooms and your checklist topics. Never video, audio, screenshots or file paths." Then one line per
provider: Claude Code "Goes through your Claude subscription.", Anthropic API "Billed per use to your
API account.", Local "Stays on the computer at that address.", Off "Nothing is sent."

## Settings UI (DESIGN-SYSTEM.md, Settings > AI)

Rows, in order: Provider (segmented: Claude Code, Anthropic API, Local, Off); then per provider:
- Claude Code: "Claude Code" (found or not), "Model" (Sonnet, Opus).
- Anthropic API: "API key" (a 34px text field, masked, with "Save"; once saved: "Saved in Windows
  Credential Manager, ends in abcd" and "Remove"), "Model" (Opus 5.5, Sonnet 5.5).
- Local: "Address" (text field), "Model" (text field), both saved on Enter or when the field is left.
- Then "Connection" ("Test connection" button; the result sentence after it), "What is sent" (the
  sentence for the picked provider), Whisper and Models as today.
New styles: `.st-field`, the picker's box as a text field (34px, 1px line border, 10px padding, mono 500,
paper text, accent focus outline), and `.st-value.wrap` for the sentences. Added to DESIGN-SYSTEM.md first.

## Tests (no money, no network)

- Rust: request bodies and headers for both HTTP providers, answer parsing, error mapping, the key's
  `Debug`, against a mock HTTP server on 127.0.0.1 (std `TcpListener`) that records the request.
  Credential Manager round trip on Windows with a test-only target name.
- TS: the provider sentences, the Off path (rules only, warning), checklist stop kinds, Settings rows in
  the browser fake.
- Claude Code path re-run end to end once on a copy of a real take.

## Out of scope

MarzOS route provider, streaming, a key per project, other OS key stores, per-feature provider choice.
