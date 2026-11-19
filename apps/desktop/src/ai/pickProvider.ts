import { FakeProvider, type AiProvider } from "@marz/autoedit";
import { isTauri } from "../platform";
import { ClaudeCodeProvider } from "./claudeCodeProvider";

/** Claude Code in the desktop app; the fixture provider in a plain browser (dev and tests). */
export function pickProvider(): AiProvider {
  return isTauri() ? new ClaudeCodeProvider() : new FakeProvider();
}
