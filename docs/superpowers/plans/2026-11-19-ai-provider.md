# Swappable AI provider: plan (2026-11-19)

Design: `docs/superpowers/specs/2026-11-19-ai-provider-design.md`.

1. **Rust key store** `src-tauri/src/secret.rs`: `Secret` (Debug `***`), `save`, `load`, `delete` on
   Windows Credential Manager (`Win32_Security_Credentials`); `last4`. Test: round trip with a test target.
2. **Rust provider** `src-tauri/src/provider.rs`: `ProviderKind`, `AiConfig` (in `settings.json` `ai`),
   `Purpose` (edit, checklist), `anthropic_body`, `parse_anthropic`, `openai_body`, `parse_openai`,
   `http_json` (ureq, status not an error), `ask_anthropic`, `ask_local`, `test_*`, `ask` dispatcher with
   cancel (request on a thread, flag polled). New `AiError` kinds: `off`, `noKey`, `badKey`, `unreachable`.
   Tests against a mock server on 127.0.0.1.
3. **Wire** `ai_edit_pass` and `checklist_ai` through `provider::ask`; Claude Code branch calls the
   unchanged `run_claude`. `ai_edit_pass` returns `{ text, provider, model }`. Commands:
   `ai_provider_get`, `ai_provider_set`, `ai_key_save`, `ai_key_remove`, `ai_provider_test`.
4. **TS**: `AiProviderError` kinds; `desktopProvider.ts` (was `claudeCodeProvider.ts`); async
   `pickProvider` (Off gives no provider plus the Off sentence); new sentences in `runAiPass`; checklist
   stop kinds. Tests.
5. **Settings UI**: DESIGN-SYSTEM.md Settings > AI rows and `.st-field`; `settingsApi` methods and the
   browser fake; `AiProviderRows` in `rows.tsx`; Settings uses it (onboarding keeps the status rows).
6. **Checks**: `pnpm typecheck`, `pnpm test`, `pnpm design:check`, `cargo test --workspace`; Settings in
   Edge at 1440 x 900 and 1280 x 720 for each provider; Claude Code end to end on a copy of a real take.
7. **Docs**: CLAUDE.md "Built (not merged)" line, LEARNINGS if anything non-obvious. Commit on the branch.
