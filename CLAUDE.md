# Marz Recorder

Windows-first screen recorder + non-destructive editor (Tauri 2, Rust, React/TS). Owner: Mauricio.

## Read first

1. `docs/product-spec.md` — the full product vision.
2. `docs/superpowers/specs/2026-11-15-milestone-1-design.md` — what is being built now (Milestone 1)
   and the `project.marz` format contract.

## Current status

- Repo contains docs only. No code, no scaffold yet.
- The Milestone 1 design is a **draft awaiting Mauricio's approval**.

## Next steps (in order)

1. Walk Mauricio through the M1 design; get approval or changes.
2. Write the implementation plan (superpowers:writing-plans).
3. On Windows: spike capture first (design doc, "Technical calls" 3–5) before building on it.
4. Scaffold the monorepo and start M1 build order.

## Rules

- Raw tracks (`screen.mp4`, `mic.wav`, `events.jsonl`) are never modified by the editor.
- The `project.marz` format is the contract between recorder and editor. Don't change it without
  updating the design doc and telling Mauricio.
- The editor must keep running in a plain browser against the sample project, so cloud (Linux)
  sessions can build and test it. Windows-only code stays in `crates/capture` and the Tauri shell.
- Don't claim capture/Tauri code works unless it was run on Windows.
- Stay inside M1 scope. Park other ideas instead of building them.
- Mauricio is short on time: answers straight to the point.
