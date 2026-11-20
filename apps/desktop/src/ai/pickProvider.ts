import { FakeProvider, type AiProvider } from "@marz/autoedit";
import { isTauri } from "../platform";
import { settingsApi } from "../settings/settingsApi";
import { DesktopProvider } from "./desktopProvider";
import { SENTENCES } from "./runAiPass";

/** The provider for this AI pass, and the sentence to show when there is none on purpose. */
export type Picked = { provider: AiProvider | null; note: string | null };

/** The provider picked in Settings in the desktop app (Claude Code when it cannot be read); the
 * fixture provider in a plain browser (dev and tests). Off gives no provider: rules only. */
export async function pickProvider(): Promise<Picked> {
  if (!isTauri()) return { provider: new FakeProvider(), note: null };
  try {
    const v = await settingsApi().aiProvider();
    if (v.provider === "off") return { provider: null, note: SENTENCES.off };
    if (v.provider === "anthropic") return { provider: new DesktopProvider("anthropic", v.anthropicModel), note: null };
    if (v.provider === "local") return { provider: new DesktopProvider("local", v.localModel), note: null };
  } catch (e) {
    console.warn("AI provider settings unavailable", e);
  }
  return { provider: new DesktopProvider(), note: null };
}
