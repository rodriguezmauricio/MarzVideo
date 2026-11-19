# Light theme: plan

Design: `docs/superpowers/specs/2026-11-19-light-theme-design.md`.

1. Tokens: add brand, accent-on-ink and accent-on-paper tokens and the `:root[data-theme="light"]` block to
   `docs/design/avant-garde/tokens.css`; copy to `apps/desktop/src/styles/tokens.css`. Write section 3
   "Light theme" in `DESIGN-SYSTEM.md`, the Home toggle in section 6, the `contrast` icon in `icons.md`.
2. Video reads brand tokens: `captionStyle.ts`, `cameraColors.ts`, `DrawLayer.tsx`, `exportVideo.ts`.
   Swatches showing video colours (`.sw-*`, `.dr-sw-*`) use brand tokens.
3. Bare accent uses switch to `--accent-on-ink` / `--accent-on-paper` (editor, home, captions, vertical,
   recorder CSS). Fills with accent-ink text and video overlays keep `--accent`.
4. `src/theme.ts` (read, set, apply, follow Windows and other windows) with tests; call it in the three entry
   files; `ThemeButton.tsx` in the Home strip; `contrast` icon.
5. Extend `tools/design-check/check.mjs` (theme-in-tokens, video-brand-token, light block completeness, token copy equal).
6. Check: `pnpm typecheck`, `pnpm test`, `pnpm design:check`; 1440 x 900 screenshots of Home, Editor (inspector,
   timeline, export panel) and the recorder fake pages in both themes.
7. Commit on the branch, status line in `CLAUDE.md`. No merge.
