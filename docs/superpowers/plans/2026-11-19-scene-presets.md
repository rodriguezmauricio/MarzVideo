# Scene presets ("looks") plan

Design: `docs/superpowers/specs/2026-11-19-scene-presets-design.md`.

1. `packages/timeline/src/looks.ts` + tests: `lookOf`, `applyLook` (one undo step, same look returns `p`,
   keeps scenes and visible, copies background whole, null background removes it), `isFreshTake`.
2. `apps/desktop/src/looks/lookFile.ts` + tests: parse (broken reads empty, unknown keys kept), name
   rules, upsert (replace by name ignoring case), remove (clears the default when it names it),
   `setDefault` (stamps `since`), `defaultLookFor(file, project)` (the first-open rule).
3. `apps/desktop/src-tauri/src/looks.rs`: `looks_get`, `looks_set` (atomic write) + unit tests; register
   in `lib.rs`.
4. `apps/desktop/src/looks/looksApi.ts`: Tauri or localStorage `marz.looks`.
5. `LookBlock.tsx` first in the Project panel; CSS in editor.css with existing tokens only.
6. `editorStore.load`: default look after the live imports; `lookNote` in the store.
7. Settings Devices "Look" row.
8. DESIGN-SYSTEM.md Look block and Settings row.
9. Checks: typecheck, test, design:check, cargo test; browser at 1440 x 900 and 1280 x 720 on demo
   (save, apply, undo, default for a new take via a copy of the sample with a new `createdAt`).
10. CLAUDE.md status line; commit to the branch.
