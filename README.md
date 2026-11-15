# Marz Recorder

Windows-first screen recorder and editor. Records screen, mic and input events as separate tracks;
zooms and cuts are editable data on top, never baked in.

Status: planning. See `docs/`.

## Start working locally (Windows 11)

Install once:

- Git
- Node.js 20+ and pnpm (`npm i -g pnpm`)
- Rust via rustup, with "Desktop development with C++" from Visual Studio Build Tools
- FFmpeg on PATH (`winget install Gyan.FFmpeg`)
- Claude Code

Then:

```bash
git clone https://github.com/rodriguezmauricio/MarzVideo.git
cd MarzVideo
git checkout claude/optimistic-shannon-mry4y0
claude
```

In Claude Code, say: `Read CLAUDE.md and continue from "Next steps".`
